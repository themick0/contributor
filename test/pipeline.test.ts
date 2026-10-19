import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNight } from '../src/pipeline.js';
import { execute } from '../src/process.js';
import { Git } from '../src/git.js';
import { Store } from '../src/store.js';
import type { Command, GitHub, Plan, Review, Sandbox } from '../src/types.js';
import { config, fixture, issue, repoRoot, temp } from './helpers.js';

type Mode = 'success' | 'no-repro' | 'green-repro' | 'bad-fix' | 'weaken-test' | 'reject-review' | 'mutate-review' | 'cleanup-fail' | 'baseline-fail' | 'mutate-plan' | 'mutate-git' | 'mutate-regression' | 'mutate-verification' | 'restore-verification';
async function scenario(t: TestContext, mode: Mode, budget = 2000000, stateDir = temp(t)) {
  const c = config(); c.limits.softTokenBudget = budget;
  const store = new Store(stateDir); store.enqueue(issue(), 70);
  const stages: string[] = []; let removed = 0;
  const github: GitHub = { search: async () => [issue()], context: async () => ({ issue: issue(), comments: [], openPullRequests: [] }) };
  const run = await runNight(store, c, repoRoot, {
    github, clone: fixture,
    sandbox: (_a, repo, control, logs): Sandbox => ({
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
      async agent<T>(stage: string) {
        stages.push(stage);
        const plan: Plan = { decision: 'implement', reason: '', summary: 'Fix negative arguments', contributionPolicy: 'Fixture permits changes', setup: [], regression: [{ argv: [process.execPath, '--test', 'test/math.test.cjs'], cwd: '.' }], checks: [{ argv: [process.execPath, '--check', 'index.cjs'], cwd: '.' }] };
        const mutate: Command = { argv: [process.execPath, '-e', "const fs = require('node:fs'); const file = 'index.cjs'; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('=> a + b;', '=> Math.abs(a + b);'));"], cwd: '.' };
        if (mode === 'mutate-regression') plan.regression.push(mutate);
        if (mode === 'mutate-verification' || mode === 'restore-verification') plan.checks.push(mutate);
        if (mode === 'restore-verification') plan.checks.push({ argv: [process.execPath, '-e', "const fs = require('node:fs'); const file = 'index.cjs'; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('=> Math.abs(a + b);', '=> a + b;'));"], cwd: '.' });
        const review: Review = { verdict: mode === 'reject-review' ? 'changes_requested' : 'approve', summary: 'Reviewed actual diff', findings: mode === 'reject-review' ? ['missed edge case'] : [], regressionIsMeaningful: true, policyCompliant: true, title: 'fix: preserve negative addends', body: 'Fixes #1. Validated regression before and after the fix.' };
        if (stage === 'plan' && mode === 'mutate-plan') appendFileSync(join(repo, 'index.cjs'), '// unexpected edit\n');
        if (stage === 'plan' && mode === 'mutate-git') appendFileSync(join(repo, '.git/config'), '\n[filter "injected"]\nclean = touch /tmp/this-must-never-run\n');
        if (stage === 'reproduce' && mode !== 'no-repro') appendFileSync(join(repo, 'test/math.test.cjs'), mode === 'green-repro' ? "test('redundant', () => assert.equal(add(1, 2), 3));\n" : "test('negative', () => assert.equal(add(1, -2), -1));\n");
        if (stage === 'implement') {
          if (mode !== 'bad-fix') writeFileSync(join(repo, 'index.cjs'), 'exports.add = (a, b) => a + b;\n');
          if (mode === 'weaken-test') appendFileSync(join(repo, 'test/math.test.cjs'), '// tampered\n');
        }
        if (stage === 'review' && mode === 'mutate-review') appendFileSync(join(repo, 'index.cjs'), '// reviewer edited\n');
        return { value: (stage === 'plan' ? plan : stage === 'review' ? review : { status: 'done', summary: 'Done' }) as T, tokens: 10 };
      },
    }),
  }, new AbortController().signal);
  return { store, run, task: store.state.tasks[0]!, stages, removed };
}

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
  const store = new Store(temp(t)); store.enqueue(issue(1), 90); store.enqueue(issue(2), 80); store.enqueue(issue(3, 'test/second'), 70);
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
  assert.ok(store.state.tasks.every(t => t.status === 'skipped'));
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
