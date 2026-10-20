import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogFresh, criteriaHash, readCatalog, validateAssessments, validateSearchPlan, withCatalog } from '../src/repositories.js';
import { scoutRepositories } from '../src/scout.js';
import { discover } from '../src/discovery.js';
import { selectTasks } from '../src/pipeline.js';
import { atomicJson, Store } from '../src/store.js';
import type { AgentResult, RepositoryAssessment, RepositoryEvidence, RepositoryFacts, RepositoryResearch, Sandbox } from '../src/types.js';
import { config, issue, repoRoot, temp } from './helpers.js';

function facts(repo = 'new/library'): RepositoryFacts {
  return { repo, description: 'A TypeScript frontend library', stars: 5000, pushedAt: new Date().toISOString(),
    private: false, archived: false, fork: false, disabled: false, language: 'TypeScript', license: 'MIT', topics: ['frontend'] };
}
function evidence(f = facts()): RepositoryEvidence {
  const issues = [issue(1, f.repo)];
  return { facts: f, languages: ['TypeScript'], issues, sources: {
    README: 'A TypeScript library for frontend state management.',
    open_issues: JSON.stringify(issues),
    'CONTRIBUTING.md': 'Reproduce bugs with local unit tests. All contributors are welcome.',
  } };
}
function assessment(repo = 'new/library'): RepositoryAssessment {
  return { repo, decision: 'select', area: 'frontend', priority: 4, reason: 'A frontend library with a concrete arithmetic bug report.', policy: 'unspecified', evidence: [
    { source: 'README', quote: 'A TypeScript library for frontend state management.' },
    { source: 'open_issues', quote: 'Negative arguments return the wrong result' },
  ] };
}
function scenario(t: TestContext) {
  const c = config(); c.repositoryDiscovery.enabled = true;
  const store = new Store(temp(t)), calls: string[] = [], queries: string[] = [], stages: string[] = [], logs: string[] = [];
  const controller = new AbortController(); let control = '';
  const behavior = {
    plan: { queries: [{ area: 'frontend', query: 'topic:frontend language:TypeScript' }] } as unknown,
    selection: { repositories: [assessment()] } as unknown,
    planTokens: 11, selectionTokens: 17, cleanupError: false, createError: false,
    onSelect: () => {}, onRemove: () => {},
  };
  const github: RepositoryResearch = {
    searchRepositories: async query => { queries.push(query); return [facts()]; },
    repositoryFacts: async repo => { calls.push(`facts:${repo}`); return facts(repo); },
    repositoryEvidence: async f => { calls.push(`evidence:${f.repo}`); return evidence(f); },
  };
  const sandbox: Sandbox = {
    async create() {
      calls.push('create');
      const persisted = new Store(store.dir).state.scouts!.at(-1)!;
      assert.equal(persisted.status, 'running'); assert.match(persisted.sandbox, /^contrib-[a-f0-9]{8}-0$/);
      if (behavior.createError) throw new Error('Sandbox create failed after allocation');
    },
    async agent<T>(stage: string, prompt: string): Promise<AgentResult<T>> {
      stages.push(stage);
      assert.match(prompt, /English/);
      if (stage === 'scout-select') {
        assert.match(prompt, /untrusted data/); assert.ok(existsSync(join(control, 'evidence.json')));
        behavior.onSelect();
      }
      return { value: structuredClone(stage === 'scout-plan' ? behavior.plan : behavior.selection) as T,
        tokens: stage === 'scout-plan' ? behavior.planTokens : behavior.selectionTokens };
    },
    async command() { throw new Error('Scouting must not run upstream commands'); },
    async remove() { calls.push('remove'); behavior.onRemove(); if (behavior.cleanupError) throw new Error('Removal failed'); },
  };
  const run = (force = false) => scoutRepositories(store, c, repoRoot, {
    github, log: line => logs.push(line), sandbox: (_scout, repo, directory) => {
      control = directory; assert.equal(repo, join(directory, '..', 'repo')); return sandbox;
    },
  }, controller.signal, force);
  return { c, store, calls, queries, stages, logs, github, behavior, controller, run };
}

test('AI plans searches, evaluates live evidence, and activates a catalog only after cleanup', async t => {
  const f = scenario(t);
  f.behavior.onRemove = () => assert.equal(existsSync(join(f.store.dir, 'repositories.json')), false);
  const result = await f.run();
  assert.equal(result.scout!.status, 'ready'); assert.equal(result.tokens, 28);
  assert.deepEqual(f.stages, ['scout-plan', 'scout-select']);
  assert.match(f.queries[0]!, /^topic:frontend language:TypeScript fork:false archived:false stars:>=1000 pushed:>=\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(f.calls, ['create', 'facts:new/library', 'evidence:new/library', 'remove']);
  const catalog = readCatalog(new Store(f.store.dir), f.c)!;
  assert.deepEqual(catalog.repositories, [{ repo: 'new/library', area: 'frontend', priority: 4 }]);
  assert.deepEqual(withCatalog(f.c, catalog).repositories.map(repo => repo.repo), ['test/library', 'new/library']);
  assert.deepEqual(f.c.repositories.map(repo => repo.repo), ['test/library']);
  assert.match(readFileSync(join(result.scout!.dir, 'report.md'), 'utf8'), /concrete arithmetic bug/);
  assert.equal(JSON.parse(readFileSync(join(result.scout!.dir, 'result.json'), 'utf8')).tokens, 28);
});

test('host checks deduplicate results, balance ecosystems, and reject unsuitable metadata or languages', async t => {
  const f = scenario(t); f.c.repositoryDiscovery.maxCandidates = 4;
  f.c.repositoryDiscovery.maxRepositories = 2;
  f.c.repositoryDiscovery.excludeRepositories = ['blocked/library'];
  f.behavior.plan = { queries: [{ area: 'frontend', query: 'topic:frontend' }, { area: 'defi', query: 'topic:defi' }] };
  f.github.searchRepositories = async query => query.startsWith('topic:frontend')
    ? [facts('test/library'), facts('blocked/library'), { ...facts('old/library'), pushedAt: '2010-01-01' }, { ...facts('small/library'), stars: 3 }, facts('new/library'), facts('renamed/library'), facts('only/rust'), facts('no/issues')]
    : [facts('chain/sdk'), facts('new/library')];
  f.github.repositoryFacts = async repo => { f.calls.push(`facts:${repo}`); return facts(repo === 'renamed/library' ? 'blocked/library' : repo); };
  f.github.repositoryEvidence = async repo => {
    f.calls.push(`evidence:${repo.repo}`);
    return { ...evidence(repo), languages: repo.repo === 'only/rust' ? ['Rust'] : ['TypeScript'] };
  };
  f.behavior.selection = { repositories: [assessment('chain/sdk'), assessment()] };
  const result = await f.run();
  assert.equal(result.scout!.status, 'ready', result.scout!.reason);
  assert.deepEqual(f.calls.filter(call => call.startsWith('facts:')), ['facts:chain/sdk', 'facts:new/library', 'facts:renamed/library', 'facts:only/rust']);
  assert.equal(f.calls.includes('evidence:blocked/library'), false);
  assert.equal(result.scout!.assessments.length, 2);
  const screening = readFileSync(join(result.scout!.dir, 'screening.json'), 'utf8');
  assert.match(screening, /No JavaScript\/TypeScript/); assert.match(screening, /Pinned, excluded/);
});

test('validated cache avoids model calls, expires on schedule, and invalidates when criteria or pinned targets change', async t => {
  const f = scenario(t); await f.run();
  const catalog = readCatalog(f.store, f.c)!;
  const cached = await f.run();
  assert.equal(cached.cached, true); assert.equal(cached.tokens, 0); assert.equal(f.stages.length, 2);
  assert.equal(catalogFresh(catalog, f.c, Date.parse(catalog.generatedAt) + 24 * 3600000), false);
  const changed = structuredClone(f.c); changed.repositoryDiscovery.minStars++;
  assert.notEqual(criteriaHash(changed), criteriaHash(f.c)); assert.equal(readCatalog(f.store, changed), undefined);
  changed.repositoryDiscovery = f.c.repositoryDiscovery; changed.repositories.push({ repo: 'new/pinned', area: 'node', priority: 3 });
  assert.equal(readCatalog(f.store, changed), undefined);
  changed.repositoryDiscovery = { ...f.c.repositoryDiscovery, enabled: false };
  assert.deepEqual(withCatalog(changed, catalog).repositories, changed.repositories);
  await f.run(true); assert.equal(f.stages.length, 4);
  assert.equal(f.store.state.scouts!.length, 2);
});

test('invalid model selections, fetch failures, and cleanup failures preserve the last successful catalog', async t => {
  for (const mode of ['invented', 'fetch', 'cleanup', 'create'] as const) {
    const f = scenario(t); await f.run();
    const before = readFileSync(join(f.store.dir, 'repositories.json'), 'utf8');
    if (mode === 'invented') f.behavior.selection = { repositories: [assessment('invented/library')] };
    if (mode === 'fetch') f.github.repositoryEvidence = async () => { throw new Error('API temporarily unavailable'); };
    if (mode === 'cleanup') f.behavior.cleanupError = true;
    if (mode === 'create') f.behavior.createError = true;
    const result = await f.run(true);
    assert.equal(result.scout!.status, 'failed', mode);
    assert.equal(readFileSync(join(f.store.dir, 'repositories.json'), 'utf8'), before, mode);
    assert.equal(f.calls.at(-1), 'remove', mode);
    if (mode === 'cleanup') {
      assert.ok(result.scout!.cleanupError);
      await assert.rejects(f.run(), /needs recover/);
    }
  }
});

test('catalog rotation retains accepted backlog for execution without discovering more issues in retired targets', async t => {
  const f = scenario(t); await f.run();
  f.store.enqueue(issue(1, 'new/library'), 90);
  f.github.searchRepositories = async () => [facts('next/library')];
  f.behavior.selection = { repositories: [assessment('next/library')] };
  await f.run(true);
  const saved = new Store(f.store.dir), catalog = readCatalog(saved, f.c)!;
  assert.deepEqual(catalog.repositories.map(repo => repo.repo), ['next/library']);
  assert.deepEqual(catalog.retainedRepositories?.map(repo => repo.repo), ['new/library']);
  const execution = withCatalog(f.c, catalog, saved.queued());
  assert.deepEqual(selectTasks(saved.queued(), execution).map(task => task.id), ['new/library#1']);
  const searched: string[] = [];
  await discover(saved, withCatalog(f.c, catalog), {
    search: async repo => { searched.push(repo); return []; },
    context: async () => { throw new Error('No issue context is needed for an empty result'); },
  }, () => {});
  assert.deepEqual(searched, ['test/library', 'next/library']);
  // Another successful refresh, even with no recommendations, preserves the backlog.
  f.github.searchRepositories = async () => [];
  await f.run(true);
  const empty = readCatalog(f.store, f.c)!;
  assert.deepEqual(empty.repositories, []);
  assert.deepEqual(selectTasks(f.store.queued(), withCatalog(f.c, empty, f.store.queued())).map(task => task.id), ['new/library#1']);
  f.store.state.tasks[0]!.status = 'ready'; f.store.save();
  await f.run(true);
  assert.deepEqual(readCatalog(f.store, f.c)!.retainedRepositories, []);
});

test('retained failed work can be explicitly retried and still respects disabled scouting or exclusions', async t => {
  const f = scenario(t); await f.run();
  f.store.enqueue(issue(1, 'new/library'), 90); f.store.state.tasks[0]!.status = 'failed'; f.store.save();
  f.github.searchRepositories = async () => []; await f.run(true);
  const catalog = readCatalog(f.store, f.c)!;
  assert.deepEqual(catalog.retainedRepositories?.map(repo => repo.repo), ['new/library']);
  assert.deepEqual(withCatalog(f.c, catalog, f.store.queued()).repositories, f.c.repositories);
  f.store.state.tasks[0]!.status = 'queued'; f.store.save();
  assert.equal(selectTasks(f.store.queued(), withCatalog(f.c, catalog, f.store.queued())).length, 1);
  const disabled = structuredClone(f.c); disabled.repositoryDiscovery.enabled = false;
  assert.deepEqual(selectTasks(f.store.queued(), withCatalog(disabled, catalog, f.store.queued())), []);
  const excluded = structuredClone(f.c); excluded.repositoryDiscovery.excludeRepositories = ['new/library'];
  assert.equal(readCatalog(f.store, excluded), undefined);
  assert.deepEqual(selectTasks(f.store.queued(), withCatalog(excluded, readCatalog(f.store, excluded), f.store.queued())), []);
  atomicJson(join(f.store.dir, 'repositories.json'), { ...catalog, retainedRepositories: [{ repo: 'unverified/library', area: 'frontend', priority: 4 }] });
  assert.equal(readCatalog(f.store, f.c), undefined);
});

test('cancellation and reported token budgets stop scouting and retain evidence without activation', async t => {
  const f = scenario(t); f.c.repositoryDiscovery.softTokenBudget = 10;
  const budget = await f.run();
  assert.equal(budget.scout!.status, 'failed'); assert.match(budget.scout!.reason, /token budget/);
  assert.equal(budget.tokens, 11); assert.equal(f.queries.length, 0); assert.equal(f.calls.at(-1), 'remove');
  const cancelled = scenario(t); cancelled.behavior.onSelect = () => cancelled.controller.abort();
  const result = await cancelled.run();
  assert.equal(result.scout!.status, 'interrupted'); assert.equal(result.tokens, 28);
  assert.equal(existsSync(join(cancelled.store.dir, 'repositories.json')), false);
  assert.equal(cancelled.calls.at(-1), 'remove');
});

test('a cancellation during cleanup cannot activate the new catalog', async t => {
  const f = scenario(t); f.behavior.onRemove = () => f.controller.abort();
  const result = await f.run();
  assert.equal(result.scout!.status, 'interrupted'); assert.equal(existsSync(join(f.store.dir, 'repositories.json')), false);
});

test('no suitable candidates produces a valid empty catalog without a selection model request', async t => {
  const f = scenario(t); f.github.repositoryEvidence = async repo => ({ ...evidence(repo), issues: [] });
  const result = await f.run();
  assert.equal(result.scout!.status, 'ready'); assert.deepEqual(result.scout!.selected, []);
  assert.deepEqual(f.stages, ['scout-plan']); assert.deepEqual(readCatalog(f.store, f.c)!.repositories, []);
});

test('exhausted GitHub retries stop later searches and an incomplete scout requires recovery', async t => {
  const f = scenario(t);
  f.behavior.plan = { queries: [{ area: 'frontend', query: 'topic:frontend' }, { area: 'defi', query: 'topic:defi' }] };
  let searches = 0;
  f.github.searchRepositories = async () => { searches++; Object.defineProperty(f.github, 'stopReason', { value: 'GitHub rate limit after 5 retries' }); throw new Error('Throttled'); };
  const result = await f.run();
  assert.equal(searches, 1); assert.match(result.scout!.reason, /rate limit after 5 retries/);
  result.scout!.status = 'running'; f.store.save();
  await assert.rejects(f.run(), /needs recover/);
});

test('model validation rejects fabricated sources, unsupported quotes, incomplete coverage, and disallowed policy', () => {
  const c = config(), candidates = [evidence()];
  const bad = [
    { ...assessment(), repo: 'unknown/library' },
    { ...assessment(), policy: 'prohibited' },
    { ...assessment(), policy: 'permission_required' },
    { ...assessment(), evidence: [{ source: 'README', quote: 'Text that is not in the README' }] },
    { ...assessment(), evidence: [{ source: 'invented', quote: 'A TypeScript library' }] },
    { ...assessment(), evidence: [{ source: 'constructor', quote: 'function Object' }] },
    { ...assessment(), evidence: [assessment().evidence[0]] },
    { ...assessment(), area: 'invented-area' },
    { ...assessment(), priority: 10 },
  ];
  for (const value of bad) assert.throws(() => validateAssessments({ repositories: [value] }, candidates, c));
  assert.throws(() => validateAssessments({ repositories: [] }, candidates, c), /every verified/);
  assert.throws(() => validateSearchPlan({ queries: [{ area: 'frontend', query: 'a\nb' }] }, c), /query/);
  assert.throws(() => validateSearchPlan({ queries: [{ area: 'frontend', query: 'topic:frontend' }, { area: 'frontend', query: 'topic:frontend' }] }, c), /Duplicate/);
  assert.equal(validateAssessments({ repositories: [assessment()] }, candidates, c).length, 1);
});

test('corrupt catalogs fall back to pinned targets and cannot import arbitrary paths', async t => {
  const f = scenario(t); await f.run();
  const catalog = readCatalog(f.store, f.c)!;
  for (const patch of [{ scoutId: '../../outside' }, { repositories: [assessment('outside/../../path')] }, { generatedAt: 'invalid' }]) {
    atomicJson(join(f.store.dir, 'repositories.json'), { ...catalog, ...patch });
    const warnings: string[] = [];
    assert.equal(readCatalog(f.store, f.c, warning => warnings.push(warning)), undefined); assert.equal(warnings.length, 1);
  }
});
