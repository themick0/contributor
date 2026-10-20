import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNight } from '../src/pipeline.js';
import { execute } from '../src/process.js';
import { Git } from '../src/git.js';
import { Store } from '../src/store.js';
import type { Command, Config, GitHub, Plan, Review, Sandbox } from '../src/types.js';
import { config, fixture, issue, repoRoot, temp } from './helpers.js';

type Mode = 'success' | 'no-repro' | 'green-repro' | 'bad-fix' | 'weaken-test' | 'reject-review' | 'mutate-review' | 'cleanup-fail' | 'baseline-fail' | 'mutate-plan' | 'mutate-git' | 'mutate-regression' | 'mutate-verification' | 'restore-verification'
  | 'repair-check' | 'repair-verification' | 'repair-review' | 'repair-mutation' | 'repair-blocked' | 'policy-review' | 'invalid-regression-review' | 'mutate-failing-check';

test('persistent GitHub throttling stops new attempts and retains queued tasks', async t => {
  const c = config(); c.limits.concurrency = 1; c.limits.maxTasksPerRepo = 2;
  const store = new Store(temp(t)); store.enqueue(issue(1), 70); store.enqueue(issue(2), 60);
  let stopReason: string | undefined;
  const github: GitHub = {
    get stopReason() { return stopReason; },
    search: async () => [],
    context: async (_repo, _number, signal) => {
      assert.ok(signal); stopReason = 'GitHub rate limit after 5 retries'; throw new Error(stopReason);
    },
  };
  const run = await runNight(store, c, repoRoot, { github, clone: async () => { throw new Error('Unexpected clone'); } }, new AbortController().signal);
  assert.equal(run.reason, stopReason);
  const saved = new Store(store.dir);
  assert.equal(saved.state.tasks[0]!.status, 'failed');
  assert.equal(saved.state.tasks[1]!.status, 'queued');
  assert.equal(saved.state.tasks[1]!.attempts.length, 0);
});

async function scenario(t: TestContext, mode: Mode, budget = 2000000, stateDir = temp(t), linkedIssues = 0, declinedPlans = 0, options: {
  night?: boolean;
  configure?: (c: Config, store: Store, github: GitHub) => void;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
} = {}) {
  const c = config(); c.limits.softTokenBudget = budget;
  const store = new Store(stateDir);
  for (let number = 1; number <= linkedIssues + declinedPlans + 1; number++) store.enqueue(issue(number), 100 - number);
  const stages: string[] = [], prompts = new Map<string, string>(); let removed = 0;
  const github: GitHub = { search: async () => [issue()], context: async (repo, number) => ({
    issue: issue(number, repo), comments: [],
    openPullRequests: number <= linkedIssues ? [`https://github.com/${repo}/pull/${100 + number}`] : [],
  }) };
  options.configure?.(c, store, github);
  const run = await runNight(store, c, repoRoot, {
    github, clone: fixture,
    ...(options.night ? { discoveryRepositories: c.repositories } : {}),
    sandbox: (attempt, repo, control, logs): Sandbox => ({
      create: async () => {
        // Use the same canonical paths for Git, sandbox mounts, and control artifacts.
        for (const path of [repo, control, logs]) assert.equal(path, realpathSync(path));
      },
      remove: async () => { removed++; if (mode === 'cleanup-fail') throw new Error('VM refused to stop'); },
      command: async (command: Command, log, signal) => {
        if (mode === 'baseline-fail') { writeFileSync(log, 'baseline error'); return 1; }
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        return (await execute(command.argv, { cwd: join(repo, command.cwd), log, signal, env })).code;
      },
      async agent<T>(stage: string, prompt: string) {
        stages.push(stage); prompts.set(stage, prompt); options.onStage?.(stage);
        const plan: Plan = { decision: 'implement', reason: '', summary: 'Fix negative arguments', contributionPolicy: 'Fixture permits changes', setup: [], regression: [{ argv: [process.execPath, '--test', 'test/math.test.cjs'], cwd: '.' }], checks: [{ argv: [process.execPath, '--check', 'index.cjs'], cwd: '.' }] };
        const number = store.state.tasks.find(task => task.attempts.includes(attempt))!.issue.number;
        if (number <= linkedIssues + declinedPlans) { plan.decision = 'skip'; plan.reason = 'Existing behavior is intentional'; }
        const mutate: Command = { argv: [process.execPath, '-e', "const fs = require('node:fs'); const file = 'index.cjs'; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('=> a + b;', '=> Math.abs(a + b);'));"], cwd: '.' };
        if (mode === 'mutate-regression') plan.regression.push(mutate);
        if (mode === 'mutate-verification' || mode === 'restore-verification') plan.checks.push(mutate);
        if (mode === 'restore-verification') plan.checks.push({ argv: [process.execPath, '-e', "const fs = require('node:fs'); const file = 'index.cjs'; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('=> Math.abs(a + b);', '=> a + b;'));"], cwd: '.' });
        if (mode === 'repair-verification') plan.checks.push({ argv: [process.execPath, '-e', "process.exit(require('node:fs').readFileSync('index.cjs', 'utf8').includes('incomplete fix') ? 1 : 0)"], cwd: '.' });
        if (mode === 'mutate-failing-check') plan.checks.push({ argv: [process.execPath, '-e', "const fs = require('node:fs'); if (fs.readFileSync('index.cjs', 'utf8').includes('=> a + b;')) { fs.appendFileSync('index.cjs', '// changed by check\\n'); process.exit(1); }"], cwd: '.' });
        const rejected = mode === 'reject-review' || mode === 'repair-review' && stage === 'review';
        const review: Review = { verdict: rejected ? 'changes_requested' : 'approve', summary: 'Reviewed actual diff', findings: rejected ? ['missed edge case'] : [], regressionIsMeaningful: mode !== 'invalid-regression-review', policyCompliant: mode !== 'policy-review', title: 'fix: preserve negative addends', body: 'Fixes #1. Validated regression before and after the fix.' };
        if (stage === 'plan' && mode === 'mutate-plan') appendFileSync(join(repo, 'index.cjs'), '// unexpected edit\n');
        if (stage === 'plan' && mode === 'mutate-git') appendFileSync(join(repo, '.git/config'), '\n[filter "injected"]\nclean = touch /tmp/this-must-never-run\n');
        if (stage === 'reproduce' && mode !== 'no-repro') appendFileSync(join(repo, 'test/math.test.cjs'), mode === 'green-repro' ? "test('redundant', () => assert.equal(add(1, 2), 3));\n" : "test('negative', () => assert.equal(add(1, -2), -1));\n");
        if (stage === 'implement') {
          if (!['bad-fix', 'repair-check', 'repair-mutation', 'repair-blocked'].includes(mode)) writeFileSync(join(repo, 'index.cjs'), 'exports.add = (a, b) => a + b;\n');
          if (mode === 'weaken-test') appendFileSync(join(repo, 'test/math.test.cjs'), '// tampered\n');
          if (mode === 'repair-verification') appendFileSync(join(repo, 'index.cjs'), '// incomplete fix\n');
        }
        if (stage.startsWith('repair-')) {
          if (mode.startsWith('repair-')) writeFileSync(join(repo, 'index.cjs'), 'exports.add = (a, b) => a + b;\n');
          if (mode === 'repair-mutation') appendFileSync(join(repo, 'test/math.test.cjs'), '// tampered during repair\n');
          if (mode === 'repair-review') appendFileSync(join(repo, 'index.cjs'), '// Preserve both signs.\n');
          if (mode === 'repair-blocked') return { value: { status: 'blocked', summary: 'Requires a behavior decision from maintainers' } as T, tokens: 10 };
        }
        if (stage === 'review' && mode === 'mutate-review') appendFileSync(join(repo, 'index.cjs'), '// reviewer edited\n');
        return { value: (stage === 'plan' ? plan : stage.startsWith('review') ? review : { status: 'done', summary: 'Done' }) as T, tokens: 10 };
      },
    }),
  }, options.signal ?? new AbortController().signal);
  return { store, run, task: store.state.tasks[linkedIssues + declinedPlans]!, stages, prompts, removed };
}

test('night refills a full stale queue and produces a verified contribution in the same run', async t => {
  let searches = 0;
  const result = await scenario(t, 'success', 2000000, temp(t), 0, 0, {
    night: true, configure(c, _store, github) {
      c.discovery.maxQueued = 1; c.limits.maxTasks = 1;
      github.search = async () => { searches++; return [issue(1), issue(2)]; };
      github.context = async (repo, number) => ({ issue: { ...issue(number, repo), state: number === 1 ? 'closed' : 'open' }, comments: [], openPullRequests: [] });
    },
  });
  assert.deepEqual(result.store.state.tasks.map(task => task.status), ['skipped', 'ready']);
  assert.equal(searches, 1); assert.equal(result.run.discoveryRounds, 1);
  assert.equal(result.run.tokens, 40); assert.equal(result.store.state.runs.length, 1);
  assert.ok(result.store.state.tasks[1]!.attempts[0]!.commit);
  assert.match(result.run.discoveryStop!, /Work attempt limit/);
});

test('night continues through planner declines using buffered candidates without repeating searches', async t => {
  let searches = 0;
  const result = await scenario(t, 'success', 2000000, temp(t), 0, 3, {
    night: true, configure(c, store, github) {
      c.discovery.maxQueued = 1; c.limits.maxTasks = 1; store.state.tasks.splice(1);
      const updatedAt = new Date().toISOString();
      github.search = async () => { searches++; return [2, 3, 4].map(number => ({ ...issue(number), updatedAt })); };
    },
  });
  assert.deepEqual(result.store.state.tasks.map(task => task.status), ['skipped', 'skipped', 'skipped', 'ready']);
  assert.equal(searches, 1); assert.equal(result.run.discoveryRounds, 3);
  assert.equal(result.run.tokens, 70); assert.equal(result.store.state.runs.length, 1);
  assert.equal(result.run.taskIds.length, 4); assert.equal(result.removed, 4);
});

test('night discovery rounds share global and repository work quotas', async t => {
  const c = config(); c.discovery.maxQueued = 1; c.limits.maxTasks = 2;
  c.repositories.push({ repo: 'test/second', area: 'node', priority: 4 });
  const store = new Store(temp(t)), searches: string[] = [], clones: string[] = [];
  const run = await runNight(store, c, repoRoot, {
    discoveryRepositories: c.repositories,
    github: {
      search: async repo => { searches.push(repo); return [issue(1, repo), issue(2, repo)]; },
      context: async (repo, number) => ({ issue: issue(number, repo), comments: [], openPullRequests: [] }),
    },
    clone: async repo => { clones.push(repo); throw new Error('Fixture clone failure'); },
  }, new AbortController().signal);
  assert.deepEqual(searches, ['test/library', 'test/second']); assert.deepEqual(clones, searches);
  assert.equal(run.discoveryRounds, 2); assert.equal(run.taskIds.length, 2);
  assert.ok(store.state.tasks.every(task => task.status === 'failed'));
});

test('night stops discovery on result exhaustion or the round limit without retrying history', async t => {
  for (const exhausted of [true, false]) {
    const c = config(); c.discovery.maxRoundsPerNight = 2; c.discovery.issuesPerRepo = 1; c.discovery.maxPagesPerRepo = 1;
    const store = new Store(temp(t)), pages: number[] = [];
    const run = await runNight(store, c, repoRoot, {
      discoveryRepositories: c.repositories,
      github: {
        search: async (repo, _limit, page = 1) => { pages.push(page); return exhausted ? [] : [issue(page, repo)]; },
        context: async (repo, number) => ({ issue: issue(number, repo), comments: [], openPullRequests: [`https://github.com/${repo}/pull/100`] }),
      },
      clone: async () => { throw new Error('No eligible work should be cloned'); },
    }, new AbortController().signal);
    assert.deepEqual(pages, exhausted ? [1] : [1, 2]);
    assert.equal(run.discoveryRounds, exhausted ? 1 : 2); assert.equal(run.taskIds.length, 0);
    assert.match(run.discoveryStop!, exhausted ? /exhausted/ : /round limit/);
    assert.equal(run.reason, '');
  }
});

test('night does not reset token usage or cancellation when refilling', async t => {
  let searches = 0;
  const result = await scenario(t, 'success', 10, temp(t), 0, 1, {
    night: true, configure(c, store, github) {
      c.discovery.maxQueued = 1; store.state.tasks.splice(1);
      github.search = async () => { searches++; return [issue(2)]; };
    },
  });
  assert.equal(searches, 0); assert.equal(result.run.discoveryRounds, 0); assert.match(result.run.reason, /budget/);
  const c = config(), store = new Store(temp(t)), controller = new AbortController();
  const cancelled = await runNight(store, c, repoRoot, {
    discoveryRepositories: c.repositories,
    github: {
      search: async (_repo, _limit, _page, signal) => { searches++; controller.abort(); signal!.throwIfAborted(); return []; },
      context: async () => { throw new Error('No calls after cancellation'); },
    },
  }, controller.signal);
  assert.equal(searches, 1); assert.equal(cancelled.discoveryRounds, 1);
  assert.match(cancelled.reason, /Interrupted/); assert.equal(cancelled.taskIds.length, 0);
});

for (const mode of ['repair-check', 'repair-verification', 'repair-review'] as const) {
  test(`repairs ${mode} and retains evidence before a fresh passing review`, async t => {
    const result = await scenario(t, mode);
    assert.equal(result.task.status, 'ready', result.task.reason);
    const attempt = result.task.attempts[0]!;
    assert.equal(attempt.repairs?.length, 1); assert.equal(result.removed, 1); assert.ok(attempt.commit);
    assert.equal(result.run.tokens, mode === 'repair-review' ? 60 : 50);
    assert.ok(result.stages.includes('repair-1')); assert.equal(result.stages.at(-1), 'review-repair-1');
    assert.equal(attempt.checks.filter(check => check.phase === 'regression-before').length, 1);
    assert.equal(attempt.checks.find(check => check.phase === 'regression-before')!.exitCode, 1);
    assert.ok(attempt.checks.filter(check => check.phase.endsWith('repair-1')).every(check => check.exitCode === 0));
    assert.ok(existsSync(join(attempt.dir, 'control', 'repair-1.feedback.json')));
    assert.ok(existsSync(join(attempt.dir, 'review-repair-1.json')));
    const original = readFileSync(join(attempt.dir, 'control', 'candidate.patch'), 'utf8');
    const repaired = readFileSync(join(attempt.dir, 'control', 'candidate-repair-1.patch'), 'utf8');
    assert.notEqual(original, repaired);
    assert.equal(repaired, readFileSync(join(attempt.dir, 'change.patch'), 'utf8'));
    assert.match(result.prompts.get('repair-1')!, /protectedRegressionFiles/);
    assert.match(result.prompts.get('review-repair-1')!, /currentValidationPhases/);
    if (mode === 'repair-review') {
      assert.equal(JSON.parse(readFileSync(join(attempt.dir, 'review.json'), 'utf8')).verdict, 'changes_requested');
      assert.equal(attempt.review!.verdict, 'approve');
    } else assert.ok(attempt.checks.some(check => check.phase === (mode === 'repair-check' ? 'regression-after' : 'verification') && check.exitCode === 1));
    const git = new Git(join(attempt.dir, 'repo'));
    await git.run(['apply', '--check', '--reverse', join(attempt.dir, 'change.patch')]);
  });
}

test('repair count, shared token budget, and cancellation bound further sessions', async t => {
  for (const cap of [0, 1]) {
    const result = await scenario(t, 'bad-fix', 2000000, temp(t), 0, 0, { configure: c => { c.limits.maxRepairAttempts = cap; } });
    assert.equal(result.task.status, 'failed'); assert.match(result.task.reason, /Repair limit/);
    assert.equal(result.stages.filter(stage => stage.startsWith('repair-')).length, cap);
    assert.equal(result.run.tokens, 30 + cap * 10);
  }
  const budget = await scenario(t, 'repair-check', 40);
  assert.equal(budget.task.status, 'failed'); assert.match(budget.run.reason, /budget/);
  assert.equal(budget.run.tokens, 40); assert.equal(budget.stages.at(-1), 'repair-1');
  const controller = new AbortController();
  const cancelled = await scenario(t, 'repair-check', 2000000, temp(t), 0, 0, {
    signal: controller.signal, onStage: stage => { if (stage === 'repair-1') controller.abort(); },
  });
  assert.equal(cancelled.task.status, 'interrupted'); assert.equal(cancelled.stages.at(-1), 'repair-1');
  assert.equal(cancelled.removed, 1);
});

test('repairs cannot weaken evidence, override policy, accept check mutations, or continue after a block', async t => {
  for (const [mode, reason, rounds] of [
    ['repair-mutation', /changed regression evidence/, 1], ['repair-blocked', /Repair blocked/, 1],
    ['policy-review', /Review requires changes/, 0], ['invalid-regression-review', /Review requires changes/, 0],
    ['mutate-failing-check', /changed the checkout/, 0],
  ] as const) {
    const result = await scenario(t, mode);
    assert.equal(result.task.status, 'failed', mode); assert.match(result.task.reason, reason);
    assert.equal(result.stages.filter(stage => stage.startsWith('repair-')).length, rounds);
    assert.ok(!result.task.attempts[0]!.commit); assert.equal(result.removed, 1);
  }
});

test('planning declines release the repository slot and continue to a verified contribution', async t => {
  const result = await scenario(t, 'success', 2000000, temp(t), 0, 2);
  assert.deepEqual(result.store.state.tasks.map(task => task.status), ['skipped', 'skipped', 'ready']);
  assert.deepEqual(result.stages, ['plan', 'plan', 'plan', 'reproduce', 'implement', 'review']);
  assert.equal(result.run.tokens, 60); assert.equal(result.removed, 3);
  assert.ok(result.task.attempts[0]!.commit);
  assert.ok(result.store.state.tasks.slice(0, 2).every(task => task.attempts[0]!.checks.length === 0));
});

test('planning replacements respect the token budget and successful sandbox cleanup', async t => {
  const budget = await scenario(t, 'success', 10, temp(t), 0, 2);
  assert.deepEqual(budget.store.state.tasks.map(task => task.status), ['skipped', 'queued', 'queued']);
  assert.equal(budget.run.tokens, 10); assert.match(budget.run.reason, /budget/);
  const cleanup = await scenario(t, 'cleanup-fail', 2000000, temp(t), 0, 1);
  assert.deepEqual(cleanup.store.state.tasks.map(task => task.status), ['failed', 'queued']);
  assert.ok(cleanup.store.state.tasks[0]!.attempts[0]!.cleanupError);
});

test('replaces linked issues beyond the task and repository quotas with a verified contribution', async t => {
  const result = await scenario(t, 'success', 2000000, temp(t), 4);
  assert.equal(result.task.status, 'ready', result.task.reason);
  assert.deepEqual(result.store.state.tasks.map(task => task.status), ['skipped', 'skipped', 'skipped', 'skipped', 'ready']);
  assert.deepEqual(result.stages, ['plan', 'reproduce', 'implement', 'review']);
  assert.equal(result.run.taskIds.length, 5); assert.equal(result.run.tokens, 40);
  assert.equal(result.removed, 1);
  const saved = new Store(result.store.dir);
  for (const task of saved.state.tasks.slice(0, 4)) {
    assert.equal(task.attempts.length, 1);
    assert.match(task.reason, /open PR/);
    assert.equal(task.attempts[0]!.tokens, 0);
    assert.ok(existsSync(join(task.attempts[0]!.dir, 'result.json')));
    assert.ok(existsSync(join(task.attempts[0]!.dir, 'control', 'issue.json')));
    assert.ok(!existsSync(join(task.attempts[0]!.dir, 'repo')));
  }
  assert.ok(result.task.attempts[0]!.commit);
  assert.match(readFileSync(join(result.store.dir, 'runs', result.run.id, 'report.md'), 'utf8'), /1 ready \/ 5 attempted/);
});

test('closed, assigned, excluded, and linked issues release their slots without running a model', async t => {
  const c = config(); c.limits.maxTasks = 1;
  const store = new Store(temp(t));
  for (let number = 1; number <= 6; number++) store.enqueue(issue(number), 100 - number);
  const inspected: number[] = [], cloned: string[] = [];
  const run = await runNight(store, c, repoRoot, {
    github: { search: async () => [], context: async (repo, number) => {
      inspected.push(number);
      const current = issue(number, repo);
      if (number === 1) current.state = 'closed';
      if (number === 2) current.assignees = ['maintainer'];
      if (number === 3) current.labels = ['duplicate'];
      return { issue: current, comments: [], openPullRequests: number === 4 ? [`https://github.com/${repo}/pull/100`] : [] };
    } },
    clone: async (_repo, path) => { cloned.push(path); throw new Error('Fixture clone failure'); },
  }, new AbortController().signal);
  assert.deepEqual(inspected, [1, 2, 3, 4, 5]); assert.equal(cloned.length, 1);
  assert.deepEqual(store.state.tasks.map(task => task.status), ['skipped', 'skipped', 'skipped', 'skipped', 'failed', 'queued']);
  assert.equal(run.tokens, 0);
  assert.equal(store.state.tasks[5]!.attempts.length, 0);
});

test('replacement scheduling respects concurrent global and per-repository attempt limits', async t => {
  const c = config(); c.limits.maxTasks = 2; c.limits.concurrency = 2;
  c.repositories.push({ repo: 'test/second', priority: 4, area: 'node' }, { repo: 'test/third', priority: 3, area: 'node' });
  const store = new Store(temp(t));
  for (const [repo, base] of [['test/library', 90], ['Test/Second', 80], ['test/third', 70], ['inactive/repo', 100]] as const) {
    for (let number = 1; number <= 3; number++) store.enqueue(issue(number, repo), base - number);
  }
  const cloned: string[] = [];
  await runNight(store, c, repoRoot, {
    github: { search: async () => [], context: async (repo, number) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { issue: issue(number, repo), comments: [], openPullRequests: number === 1 ? [`https://github.com/${repo}/pull/100`] : [] };
    } },
    clone: async repo => { cloned.push(repo.toLowerCase()); throw new Error('Fixture clone failure'); },
  }, new AbortController().signal);
  assert.deepEqual(cloned.sort(), ['test/library', 'test/second']);
  for (const repo of ['test/library', 'test/second']) {
    assert.equal(store.state.tasks.find(task => task.id === `${repo}#1`)!.status, 'skipped');
    assert.equal(store.state.tasks.find(task => task.id === `${repo}#2`)!.status, 'failed');
    assert.equal(store.state.tasks.find(task => task.id === `${repo}#3`)!.status, 'queued');
  }
  assert.ok(store.state.tasks.filter(task => /^(test\/third|inactive\/repo)#/.test(task.id)).every(task => task.status === 'queued' && task.attempts.length === 0));
});

test('an entirely ineligible queue is exhausted once without cloning or retrying history', async t => {
  const c = config(); c.limits.maxTasks = 1;
  const store = new Store(temp(t));
  for (let number = 1; number <= 5; number++) store.enqueue(issue(number), 100 - number);
  const inspected: number[] = [];
  const deps = {
    github: { search: async () => [], context: async (repo: string, number: number) => {
      inspected.push(number);
      return { issue: issue(number, repo), comments: [], openPullRequests: [`https://github.com/${repo}/pull/100`] };
    } },
    clone: async () => { throw new Error('Must not clone ineligible issues'); },
  };
  const run = await runNight(store, c, repoRoot, deps, new AbortController().signal);
  assert.deepEqual(inspected, [1, 2, 3, 4, 5]);
  assert.equal(run.taskIds.length, 5); assert.equal(run.tokens, 0);
  assert.ok(store.state.tasks.every(task => task.status === 'skipped' && task.attempts.length === 1));
  const next = await runNight(new Store(store.dir), c, repoRoot, deps, new AbortController().signal);
  assert.equal(next.taskIds.length, 0); assert.equal(inspected.length, 5);
});

test('cancellation during preflight leaves replacements queued', async t => {
  const store = new Store(temp(t)); store.enqueue(issue(1), 70); store.enqueue(issue(2), 60);
  const controller = new AbortController();
  const run = await runNight(store, config(), repoRoot, {
    github: { search: async () => [], context: async (repo, number) => {
      controller.abort();
      return { issue: issue(number, repo), comments: [], openPullRequests: [`https://github.com/${repo}/pull/100`] };
    } },
    clone: async () => { throw new Error('Must not clone after cancellation'); },
  }, controller.signal);
  assert.match(run.reason, /Interrupted/);
  assert.deepEqual(store.state.tasks.map(task => task.status), ['interrupted', 'queued']);
  assert.equal(store.state.tasks[1]!.attempts.length, 0);
});

test('end-to-end: real failing regression -> fix -> verification -> review -> local commit/draft', async t => {
  const result = await scenario(t, 'success');
  assert.equal(result.task.status, 'ready', result.task.reason);
  assert.deepEqual(result.stages, ['plan', 'reproduce', 'implement', 'review']);
  assert.equal(result.removed, 1); assert.equal(result.run.tokens, 40);
  const attempt = result.task.attempts[0]!;
  assert.ok(attempt.commit); assert.notEqual(attempt.commit, attempt.base);
  assert.equal(attempt.checks.find(c => c.phase === 'regression-before')?.exitCode, 1);
  assert.equal(attempt.checks.find(c => c.phase === 'regression-after')?.exitCode, 0);
  const git = new Git(join(attempt.dir, 'repo'));
  assert.equal(await git.snapshot(), '');
  assert.match(readFileSync(join(attempt.dir, 'PR.md'), 'utf8'), /preserve negative/);
  assert.match(readFileSync(join(result.store.dir, 'runs', result.run.id, 'report.md'), 'utf8'), /1 ready/);
  // Export is a usable patch, including its trailing newline and new regression test.
  assert.ok(readFileSync(join(attempt.dir, 'change.patch'), 'utf8').endsWith('\n'));
  await git.run(['apply', '--check', '--reverse', join(attempt.dir, 'change.patch')]);
});

test('pipeline prepares a verified contribution through a symlinked state root', { skip: process.platform === 'win32' }, async t => {
  const dir = temp(t), physical = join(dir, 'private'), alias = join(dir, 'var');
  mkdirSync(physical); symlinkSync(physical, alias, 'dir');
  const result = await scenario(t, 'success', 2000000, join(alias, 'state'));
  assert.equal(result.task.status, 'ready', result.task.reason);
  assert.equal(result.store.dir, realpathSync(join(physical, 'state')));
  const attempt = result.task.attempts[0]!;
  assert.equal(attempt.dir, realpathSync(attempt.dir)); assert.ok(attempt.commit);
  assert.ok(existsSync(join(attempt.dir, 'PR.md')));
});

for (const [mode, message] of [
  ['no-repro', /Empty diff/], ['green-repro', /Regression did not fail/], ['bad-fix', /regression-after/], ['weaken-test', /changed regression evidence/],
  ['reject-review', /Review requires changes/], ['mutate-review', /Reviewer modified/],
  ['cleanup-fail', /cleanup failed/], ['baseline-fail', /baseline/], ['mutate-plan', /baseline phase changed/], ['mutate-git', /modified Git configuration/],
] as const) {
  test(`does not mark ${mode} as ready and retains cleanup/evidence`, async t => {
    const result = await scenario(t, mode);
    assert.equal(result.task.status, 'failed'); assert.match(result.task.reason, message);
    assert.ok(result.removed >= 1);
    const attempt = result.task.attempts[0]!;
    assert.ok(!attempt.commit); assert.ok(!existsSync(join(attempt.dir, 'PR.md')));
    assert.ok(existsSync(join(attempt.dir, 'result.json')));
  });
}

for (const mode of ['mutate-regression', 'mutate-verification', 'restore-verification'] as const) {
  test(`rejects ${mode} before review even when commands exit successfully`, async t => {
    const result = await scenario(t, mode);
    assert.equal(result.task.status, 'failed', result.task.reason);
    assert.match(result.task.reason, /changed the checkout/);
    assert.ok(!result.stages.includes('review'));
    assert.equal(result.removed, 1);
    const attempt = result.task.attempts[0]!;
    const phase = mode === 'mutate-regression' ? 'regression-after' : 'verification';
    const checks = attempt.checks.filter(c => c.phase === phase);
    assert.equal(checks.length, 2); assert.ok(checks.every(c => c.exitCode === 0));
    assert.ok(!attempt.commit); assert.ok(!existsSync(join(attempt.dir, 'PR.md')));
    assert.ok(existsSync(join(attempt.dir, 'change.patch')));
    assert.ok(existsSync(join(attempt.dir, 'result.json')));
  });
}

test('soft token budget stops subsequent stages and still cleans the sandbox', async t => {
  const result = await scenario(t, 'success', 1);
  assert.equal(result.task.status, 'failed'); assert.deepEqual(result.stages, ['plan']);
  assert.match(result.run.reason, /budget/); assert.equal(result.removed, 1);
});

test('a completed review can be finalized when its last response hits the soft budget', async t => {
  const result = await scenario(t, 'success', 40);
  assert.equal(result.task.status, 'ready', result.task.reason);
  assert.equal(result.run.tokens, 40);
});

test('runs different repositories concurrently while serializing tasks in the same repository', async t => {
  const c = config(); c.limits.maxTasksPerRepo = 2;
  c.repositories.push({ repo: 'test/second', priority: 4, area: 'node' });
  const store = new Store(temp(t)); store.enqueue(issue(1), 90); store.enqueue(issue(2), 80); store.enqueue(issue(3, 'test/second'), 70); store.enqueue(issue(4), 60);
  const active = new Set<string>(); let peak = 0;
  await runNight(store, c, repoRoot, {
    github: { search: async () => [], context: async (repo, n) => ({ issue: issue(n, repo), comments: [], openPullRequests: [] }) }, clone: fixture,
    sandbox: (a): Sandbox => {
      const repoName = a.dir.includes('test--second') ? 'second' : 'library';
      return {
        create: async () => { assert.ok(!active.has(repoName)); active.add(repoName); peak = Math.max(peak, active.size); },
        remove: async () => { active.delete(repoName); }, command: async () => { throw new Error('Must not run commands for skipped plan'); },
        agent: async <T>() => {
          await new Promise(resolve => setTimeout(resolve, 40));
          return { value: { decision: 'skip', reason: 'fixture scope', summary: '', contributionPolicy: '', setup: [], regression: [], checks: [] } as T, tokens: 10 };
        },
      };
    },
  }, new AbortController().signal);
  assert.equal(peak, 2); assert.equal(active.size, 0);
  assert.deepEqual(store.state.tasks.map(task => task.status), ['skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(store.state.tasks[3]!.attempts.length, 1);
});

test('fresh issue with a linked open PR is skipped before clone/model spend', async t => {
  const store = new Store(temp(t)); store.enqueue(issue(), 70);
  const run = await runNight(store, config(), repoRoot, {
    github: { search: async () => [], context: async () => ({ issue: issue(), comments: [], openPullRequests: ['https://github.com/test/library/pull/2'] }) },
    clone: async () => { throw new Error('Must not clone'); },
  }, new AbortController().signal);
  assert.equal(store.state.tasks[0]!.status, 'skipped'); assert.equal(run.tokens, 0);
});

test('interrupted run does not claim queued work', async t => {
  const store = new Store(temp(t)); store.enqueue(issue(), 70);
  const controller = new AbortController(); controller.abort();
  const run = await runNight(store, config(), repoRoot, { github: { search: async () => [], context: async () => { throw new Error('Must not fetch'); } } }, controller.signal);
  assert.equal(store.state.tasks[0]!.status, 'queued'); assert.equal(run.taskIds.length, 0);
  assert.match(run.reason, /Interrupted/);
});

test('repository scout usage consumes the night budget before any task is claimed', async t => {
  const c = config(); c.limits.softTokenBudget = 50;
  const store = new Store(temp(t)); store.enqueue(issue(), 70);
  const run = await runNight(store, c, repoRoot, {
    initialTokens: 50, scoutDir: join(store.dir, 'scouts', 'fixture'),
    github: { search: async () => [], context: async () => { throw new Error('Must not fetch after the scout consumes the budget'); } },
  }, new AbortController().signal);
  assert.equal(run.tokens, 50); assert.equal(run.taskIds.length, 0); assert.match(run.reason, /token budget/);
  assert.equal(store.queued().length, 1);
  assert.match(readFileSync(join(store.dir, 'runs', run.id, 'report.md'), 'utf8'), /scout report/);
});
