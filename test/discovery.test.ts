import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDiscoverySession, discover, discoveryHasMore } from '../src/discovery.js';
import { loadConfig } from '../src/config.js';
import { scoreIssue } from '../src/github.js';
import { Store } from '../src/store.js';
import type { GitHub } from '../src/types.js';
import { config, issue, repoRoot, temp } from './helpers.js';

const discoveryUpdatedAt = new Date().toISOString();

test('discovery screens linked, closed, and assigned issues before they can fill the queue', async t => {
  const c = config(); c.discovery.maxQueued = 1;
  const store = new Store(temp(t));
  const issues = [1, 2, 3, 4].map(number => ({ ...issue(number), updatedAt: discoveryUpdatedAt }));
  const github: GitHub = {
    search: async () => issues,
    context: async (_repo, number) => ({
      issue: { ...issues[number - 1]!, ...(number === 2 ? { state: 'closed' } : number === 3 ? { assignees: ['maintainer'] } : {}) },
      comments: [], openPullRequests: number === 1 ? ['https://github.com/test/library/pull/100'] : [],
    }),
  };
  assert.equal(await discover(store, c, github, () => {}), 1);
  const saved = new Store(store.dir);
  assert.deepEqual(saved.state.tasks.map(task => task.status), ['skipped', 'skipped', 'skipped', 'queued']);
  assert.deepEqual(saved.queued().map(task => task.id), ['test/library#4']);
  assert.ok(saved.state.tasks.every(task => task.attempts.length === 0));
  assert.match(saved.state.tasks[0]!.reason, /pull\/100/);
});

test('discovery gives different repositories queue slots before taking more from a dominant repository', async t => {
  const c = config(); c.discovery.maxQueued = 3;
  c.repositories.push({ repo: 'test/second', priority: 2, area: 'frontend' }, { repo: 'test/third', priority: 1, area: 'node' });
  const store = new Store(temp(t));
  const candidate = (repo: string, number: number) => ({ ...issue(number, repo), labels: ['bug', 'confirmed'] });
  const github: GitHub = {
    search: async repo => Array.from({ length: 10 }, (_, index) => candidate(repo, index + 1)),
    context: async (repo, number) => ({ issue: candidate(repo, number), comments: [], openPullRequests: [] }),
  };
  assert.equal(await discover(store, c, github, () => {}), 3);
  assert.deepEqual(new Set(store.queued().map(task => task.issue.repo)), new Set(c.repositories.map(repo => repo.repo)));
});

test('discovery reaches a later page after history and remembers screened rejections across runs', async t => {
  const c = config(); c.discovery.issuesPerRepo = 2; c.discovery.maxQueued = 1;
  const store = new Store(temp(t));
  store.enqueue(issue(1), 50, 'Already handled'); store.enqueue(issue(2), 50, 'Already handled');
  const pages: number[] = [], inspected: number[] = [];
  const github: GitHub = {
    search: async (repo, _limit, page = 1) => {
      pages.push(page);
      return [issue(page * 2 - 1, repo), issue(page * 2, repo)].map(current => ({ ...current, updatedAt: discoveryUpdatedAt }));
    },
    context: async (repo, number) => {
      inspected.push(number);
      return { issue: issue(number, repo), comments: [], openPullRequests: number === 3 ? ['https://github.com/test/library/pull/100'] : [] };
    },
  };
  assert.equal(await discover(store, c, github, () => {}), 1);
  assert.deepEqual(pages, [1, 2]); assert.deepEqual(inspected, [3, 4]);
  assert.equal(new Store(store.dir).state.tasks.find(task => task.id === 'test/library#3')!.status, 'skipped');
  assert.deepEqual(store.queued().map(task => task.id), ['test/library#4']);
});

test('candidate checks are bounded and rejected candidates do not spend the next scan budget again', async t => {
  const c = config(); c.discovery.maxCandidateChecks = 2;
  const store = new Store(temp(t));
  const inspected: number[] = [];
  const github: GitHub = {
    search: async () => [1, 2, 3, 4].map(number => ({ ...issue(number), updatedAt: discoveryUpdatedAt })),
    context: async (repo, number) => {
      inspected.push(number);
      return { issue: issue(number, repo), comments: [], openPullRequests: [`https://github.com/${repo}/pull/100`] };
    },
  };
  assert.equal(await discover(store, c, github, () => {}), 0);
  assert.deepEqual(inspected, [1, 2]);
  assert.equal(await discover(new Store(store.dir), c, github, () => {}), 0);
  assert.deepEqual(inspected, [1, 2, 3, 4]);
});

test('search pagination stops at the configured bound even when every page contains known issues', async t => {
  const c = config(); c.discovery.issuesPerRepo = 1; c.discovery.maxPagesPerRepo = 2;
  const store = new Store(temp(t)); store.enqueue(issue(1), 50, 'Already handled');
  const pages: number[] = [];
  const github: GitHub = {
    search: async (_repo, _limit, page = 1) => { pages.push(page); return [issue(1)]; },
    context: async () => { throw new Error('Known history must not be screened'); },
  };
  assert.equal(await discover(store, c, github, () => {}), 0);
  assert.deepEqual(pages, [1, 2]); assert.equal(store.state.tasks.length, 1);
});

test('a repository full of linked PRs cannot consume the entire first screening round', async t => {
  const c = config(); c.discovery.maxQueued = 2; c.discovery.maxCandidateChecks = 4;
  c.repositories.push({ repo: 'test/second', priority: 4, area: 'node' });
  const store = new Store(temp(t));
  const inspected: string[] = [];
  const github: GitHub = {
    search: async repo => [1, 2, 3].map(number => ({ ...issue(number, repo), updatedAt: discoveryUpdatedAt })),
    context: async (repo, number) => {
      inspected.push(`${repo}#${number}`);
      return { issue: issue(number, repo), comments: [], openPullRequests: repo === 'test/library' && number < 3 ? [`https://github.com/${repo}/pull/100`] : [] };
    },
  };
  assert.equal(await discover(store, c, github, () => {}), 2);
  assert.deepEqual(inspected, ['test/library#1', 'test/library#2', 'test/second#1', 'test/library#3']);
});

test('a full queue avoids GitHub requests and rediscovery refreshes only queued snapshots', async t => {
  const c = config(); c.discovery.maxQueued = 1;
  const store = new Store(temp(t)); store.enqueue(issue(1), 10);
  const never: GitHub = { search: async () => { throw new Error('Unexpected search'); }, context: async () => { throw new Error('Unexpected context'); } };
  assert.equal(await discover(store, c, never, () => {}), 0);
  c.discovery.maxQueued = 2;
  const updated = { ...issue(1), title: 'Updated queued issue', labels: ['bug', 'confirmed'] };
  const github: GitHub = { search: async () => [updated, issue(2)], context: async (repo, number) => ({ issue: issue(number, repo), comments: [], openPullRequests: [] }) };
  assert.equal(await discover(store, c, github, () => {}), 1);
  const refreshed = new Store(store.dir).state.tasks[0]!;
  assert.equal(refreshed.issue.title, updated.title);
  assert.equal(refreshed.score, scoreIssue(updated, c.repositories[0]!, c));
});

test('a temporary candidate failure does not permanently reject the issue or block other candidates', async t => {
  const c = config(); c.discovery.maxQueued = 1;
  const store = new Store(temp(t));
  const github: GitHub = {
    search: async () => [1, 2].map(number => ({ ...issue(number), updatedAt: discoveryUpdatedAt })),
    context: async (repo, number) => {
      if (number === 1) throw new Error('GitHub HTTP 503 after retries');
      return { issue: issue(number, repo), comments: [], openPullRequests: [] };
    },
  };
  assert.equal(await discover(store, c, github, () => {}), 1);
  assert.deepEqual(store.state.tasks.map(task => task.id), ['test/library#2']);
});

test('ranking rewards concrete reproduction hints and recent activity rather than template headings', () => {
  const c = config(), repo = c.repositories[0]!, now = Date.parse('2026-10-19T00:00:00Z');
  const base = { ...issue(), body: '', updatedAt: '2026-10-01T00:00:00Z' };
  const template = { ...base, body: '## Reproduction\n## Expected behavior\n## Actual behavior' };
  const example = { ...base, body: '```ts\nconst result = await fetch("https://example.invalid");\n```' };
  const reproduction = { ...base, body: 'Reproduction: https://stackblitz.com/edit/example' };
  assert.equal(scoreIssue(template, repo, c, now), scoreIssue(base, repo, c, now));
  assert.ok(scoreIssue(example, repo, c, now) > scoreIssue(template, repo, c, now));
  assert.ok(scoreIssue(reproduction, repo, c, now) > scoreIssue(template, repo, c, now));
  assert.ok(scoreIssue(base, repo, c, now) > scoreIssue({ ...base, updatedAt: '2023-01-01T00:00:00Z' }, repo, c, now));
  assert.ok(scoreIssue({ ...base, labels: ['enhancement', 'good first issue'] }, repo, c, now) < scoreIssue(base, repo, c, now));
});

test('existing queue scores use recent issue activity to break ties before insertion order', t => {
  const store = new Store(temp(t));
  store.enqueue({ ...issue(1), updatedAt: '2023-01-01T00:00:00Z' }, 56);
  store.enqueue({ ...issue(2), updatedAt: '2026-10-01T00:00:00Z' }, 56);
  assert.deepEqual(new Store(store.dir).queued().map(task => task.id), ['test/library#2', 'test/library#1']);
});

test('night discovery preserves buffered candidates and advances pages without revisiting history', async t => {
  const c = config(); c.discovery.issuesPerRepo = 2; c.discovery.maxPagesPerRepo = 1; c.discovery.maxQueued = 1;
  const store = new Store(temp(t)), session = createDiscoverySession(), pages: number[] = [], checked: number[] = [];
  const github: GitHub = {
    search: async (_repo, _limit, page = 1) => {
      pages.push(page);
      return (page === 1 ? [1, 2] : page === 2 ? [2, 3] : []).map(number => ({ ...issue(number), updatedAt: discoveryUpdatedAt }));
    },
    context: async (repo, number) => { checked.push(number); return { issue: issue(number, repo), comments: [], openPullRequests: [] }; },
  };
  for (const number of [1, 2, 3]) {
    assert.equal(discoveryHasMore(session, c.repositories), true);
    assert.equal(await discover(store, c, github, () => {}, { session }), 1);
    assert.equal(store.queued()[0]!.issue.number, number);
    store.queued()[0]!.status = 'skipped'; store.save();
    assert.deepEqual(pages, number < 3 ? [1] : [1, 2]);
  }
  assert.equal(await discover(store, c, github, () => {}, { session }), 0);
  assert.deepEqual(pages, [1, 2, 3]); assert.deepEqual(checked, [1, 2, 3]);
  assert.equal(discoveryHasMore(session, c.repositories), false);
});

test('cumulative night pagination stops at the GitHub search limit', async t => {
  const c = config(); c.discovery.issuesPerRepo = 100; c.discovery.maxPagesPerRepo = 1;
  const store = new Store(temp(t)), session = createDiscoverySession(), pages: number[] = [];
  store.enqueue(issue(1), 50, 'Already handled');
  const github: GitHub = {
    search: async (_repo, _limit, page = 1) => { pages.push(page); return Array.from({ length: 100 }, () => issue(1)); },
    context: async () => { throw new Error('Known issues must not be checked'); },
  };
  for (let round = 0; round < 12 && discoveryHasMore(session, c.repositories); round++) await discover(store, c, github, () => {}, { session });
  assert.deepEqual(pages, Array.from({ length: 10 }, (_, i) => i + 1));
  assert.equal(discoveryHasMore(session, c.repositories), false);
});

test('older configs receive bounded discovery defaults and reject invalid pagination budgets', t => {
  const path = join(temp(t), 'config.json');
  const original = JSON.parse(readFileSync(join(repoRoot, 'contributor.config.json'), 'utf8'));
  delete original.discovery.maxPagesPerRepo; delete original.discovery.maxCandidateChecks; delete original.discovery.maxRoundsPerNight;
  delete original.limits.maxRepairAttempts;
  delete original.repositoryDiscovery.issuesPerPage; delete original.repositoryDiscovery.maxIssuePages; delete original.repositoryDiscovery.issueSamples;
  writeFileSync(path, JSON.stringify(original));
  const loaded = loadConfig(path);
  assert.equal(loaded.discovery.maxPagesPerRepo, 3); assert.equal(loaded.discovery.maxCandidateChecks, 60);
  assert.equal(loaded.discovery.maxRoundsPerNight, 12); assert.equal(loaded.limits.maxRepairAttempts, 2);
  assert.equal(loaded.repositoryDiscovery.issuesPerPage, 20); assert.equal(loaded.repositoryDiscovery.maxIssuePages, 3); assert.equal(loaded.repositoryDiscovery.issueSamples, 5);
  for (const [section, key, invalid] of [
    ['limits', 'maxRepairAttempts', -1], ['limits', 'maxRepairAttempts', 6],
    ['discovery', 'maxRoundsPerNight', 0], ['discovery', 'maxRoundsPerNight', 101],
    ['repositoryDiscovery', 'issuesPerPage', 101], ['repositoryDiscovery', 'maxIssuePages', 11], ['repositoryDiscovery', 'issueSamples', 11],
  ] as const) {
    const changed = structuredClone(original); changed[section][key] = invalid; writeFileSync(path, JSON.stringify(changed));
    assert.throws(() => loadConfig(path));
  }
  const noRepairs = structuredClone(original); noRepairs.limits.maxRepairAttempts = 0;
  writeFileSync(path, JSON.stringify(noRepairs)); assert.equal(loadConfig(path).limits.maxRepairAttempts, 0);
  original.discovery.maxCandidateChecks = 0; writeFileSync(path, JSON.stringify(original));
  assert.throws(() => loadConfig(path), /maxCandidateChecks/);
  original.discovery.maxCandidateChecks = 60; original.discovery.maxPagesPerRepo = 100;
  writeFileSync(path, JSON.stringify(original)); assert.throws(() => loadConfig(path), /1000-result/);
});
