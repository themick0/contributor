import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandPath, loadConfig, validatePlan } from '../src/config.js';
import { eligible, parseIssueUrl, scoreIssue } from '../src/github.js';
import { discover, selectTasks } from '../src/pipeline.js';
import { Store } from '../src/store.js';
import { config, issue, temp } from './helpers.js';
import type { GitHub } from '../src/types.js';

test('state deduplicates case-insensitive issue IDs across restarts and serializes writers', t => {
  const path = temp(t), a = new Store(path), b = new Store(path);
  const unlock = a.lock();
  assert.throws(() => b.lock(), /runner.lock/);
  assert.equal(a.enqueue(issue(), 60), true);
  assert.equal(a.enqueue(issue(1, 'Test/Library'), 70), false);
  unlock();
  const unlockB = b.lock();
  assert.equal(b.queued().length, 1); unlockB();
  assert.equal(new Store(path).state.tasks.length, 1);
});

test('validates commands, config, and URL before use as paths or process arguments', t => {
  assert.deepEqual(parseIssueUrl('https://github.com/wevm/viem/issues/123'), { repo: 'wevm/viem', number: 123 });
  for (const url of ['https://github.com/x/y/pull/1', 'https://evil.invalid/x/y/issues/1', 'https://github.com/x/y/issues/1;whoami']) assert.throws(() => parseIssueUrl(url));
  assert.throws(() => commandPath('/checkout', { argv: ['pnpm', 'test'], cwd: '../host' }));
  assert.throws(() => commandPath('/checkout', { argv: [], cwd: '.' }));
  const path = join(temp(t), 'config.json'); const c = config();
  c.limits.maxTasks = 0; writeFileSync(path, JSON.stringify(c));
  assert.throws(() => loadConfig(path), /maxTasks/);
  assert.throws(() => validatePlan({ decision: 'implement', reason: '', summary: '', contributionPolicy: 'CONTRIBUTING.md', setup: [], regression: [], checks: [] }), /regression/);
});

test('selection excludes assigned/closed/duplicate issues and enforces repository quotas', t => {
  const c = config(), i = issue();
  assert.ok(scoreIssue(i, c.repositories[0]!, c) >= c.discovery.minScore);
  for (const bad of [{ ...i, state: 'closed' }, { ...i, assignees: ['maintainer'] }, { ...i, labels: ['duplicate'] }]) {
    assert.ok(eligible(bad, c)); assert.equal(scoreIssue(bad, c.repositories[0]!, c), 0);
  }
  const store = new Store(temp(t)); store.enqueue(i, 70); store.enqueue(issue(2), 60); store.enqueue(issue(3, 'outside/repo'), 99);
  assert.deepEqual(selectTasks(store.queued(), c).map(t => t.id), ['test/library#1']);
});

test('discovery preserves history and limits the queue even across repeated scans', async t => {
  const c = config(); c.discovery.maxQueued = 1; const store = new Store(temp(t));
  const github: GitHub = { search: async () => [issue(1), issue(2)], context: async (repo, number) => ({ issue: issue(number, repo), comments: [], openPullRequests: [] }) };
  assert.equal(await discover(store, c, github, () => {}), 1);
  store.state.tasks[0]!.status = 'failed'; store.save();
  assert.equal(await discover(store, c, github, () => {}), 1);
  assert.equal(store.state.tasks.length, 2); assert.equal(store.queued().length, 1);
  store.state.tasks[1]!.status = 'failed'; store.save();
  await assert.rejects(discover(store, c, { ...github, search: async () => { throw new Error('offline'); } }, () => {}), /every repository/);
});

test('discovery counts only configured repositories while preserving inactive queued tasks', async t => {
  const c = config(); c.discovery.maxQueued = 1;
  const store = new Store(temp(t)); store.enqueue(issue(), 70);
  c.repositories = [{ repo: 'New/Library', area: 'typescript', priority: 5 }];
  const github: GitHub = { search: async repo => [issue(2, repo.toLowerCase()), issue(3, repo.toLowerCase())], context: async (repo, number) => ({ issue: issue(number, repo.toLowerCase()), comments: [], openPullRequests: [] }) };

  assert.equal(await discover(store, c, github, () => {}), 1);
  const restarted = new Store(store.dir);
  assert.equal(await discover(restarted, c, github, () => {}), 0);
  assert.equal(restarted.queued().length, 2);
  assert.deepEqual(selectTasks(restarted.queued(), c).map(t => t.id), ['new/library#2']);
  assert.equal(restarted.state.tasks.find(t => t.id === 'test/library#1')?.status, 'queued');

  c.repositories = config().repositories;
  assert.equal(await discover(restarted, c, github, () => {}), 0);
  assert.deepEqual(selectTasks(restarted.queued(), c).map(t => t.id), ['test/library#1']);
});

test('discovery stops immediately for invalid credentials or rate limits', async t => {
  const c = config(); c.repositories.push({ repo: 'test/second', area: 'node', priority: 4 });
  let calls = 0;
  const github: GitHub = { search: async () => { calls++; throw new Error('gh: Bad credentials (HTTP 401)'); }, context: async () => { throw new Error('unused'); } };
  await assert.rejects(discover(new Store(temp(t)), c, github, () => {}), /401/);
  assert.equal(calls, 1);
});

test('discovery saves earlier candidates when a later request exhausts retries or is cancelled', async t => {
  for (const error of [new Error('GitHub rate limit after 5 retries'), new DOMException('Aborted', 'AbortError')]) {
    const c = config(); c.repositories.push({ repo: 'test/second', area: 'node', priority: 4 });
    const store = new Store(temp(t));
    const github: GitHub = {
      search: async repo => { if (repo === 'test/second') throw error; return [issue()]; },
      context: async (repo, number) => ({ issue: issue(number, repo), comments: [], openPullRequests: [] }),
    };
    await assert.rejects(discover(store, c, github, () => {}), candidate => candidate === error);
    assert.deepEqual(new Store(store.dir).queued().map(task => task.id), ['test/library#1']);
  }
});

test('repository discovery has backward-compatible defaults and validates criteria and bounds', t => {
  const path = join(temp(t), 'config.json'), base = config();
  const { repositoryDiscovery: _unused, ...old } = base;
  writeFileSync(path, JSON.stringify(old));
  const defaults = loadConfig(path).repositoryDiscovery;
  assert.equal(defaults.enabled, true); assert.equal(defaults.minStars, 1000);
  assert.equal(defaults.maxCandidates, 12); assert.equal(defaults.refreshHours, 24);
  for (const patch of [{ areas: [] }, { areas: ['Node JS'] }, { areas: ['node', 'node'] }, { maxQueries: 50 },
    { maxRepositories: 13 }, { resultsPerQuery: 101 }, { minutes: 0 }, { enabled: 'yes' }, { criteria: '' },
    { excludeRepositories: ['TEST/library'] }, { excludeRepositories: ['../outside'] }]) {
    writeFileSync(path, JSON.stringify({ ...base, repositoryDiscovery: { ...defaults, ...patch } }));
    assert.throws(() => loadConfig(path));
  }
});
