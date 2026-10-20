import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from '../src/process.js';
import { writeReport } from '../src/report.js';
import { writeScoutReport } from '../src/scout.js';
import { atomicJson, Store } from '../src/store.js';
import type { Attempt, Run, ScoutRun } from '../src/types.js';
import { config, issue, repoRoot, temp } from './helpers.js';

function recoveryFixture(t: TestContext, completed = false) {
  const root = temp(t), bin = join(root, 'bin'); mkdirSync(bin);
  const c = config(); c.stateDir = 'state'; c.sandbox.command = ['sbx'];
  const configPath = join(root, 'config.json'); atomicJson(configPath, c);
  const store = new Store(join(root, c.stateDir)); store.enqueue(issue(), 70);
  const task = store.state.tasks[0]!;
  const run: Run = { id: 'interrupted-run', startedAt: '2026-01-01T01:00:00.000Z', taskIds: [task.id], tokens: 42, reason: '' };
  const attempt: Attempt = { runId: run.id, dir: join(store.dir, 'runs', run.id, 'task'), sandbox: 'contrib-1234abcd-1', branch: 'contrib/test', startedAt: run.startedAt, status: completed ? 'failed' : 'running', reason: 'Fixture', tokens: 42, checks: [] };
  mkdirSync(attempt.dir, { recursive: true });
  writeFileSync(join(attempt.dir, 'change.patch'), 'Retained contribution evidence\n');
  if (completed) {
    attempt.cleanupError = 'Initial cleanup failed'; attempt.finishedAt = '2026-01-01T02:00:00.000Z';
    run.finishedAt = attempt.finishedAt; atomicJson(join(attempt.dir, 'result.json'), attempt);
  }
  task.status = attempt.status; task.attempts.push(attempt); store.state.runs.push(run);
  store.save(); writeReport(store, run);
  writeFileSync(join(bin, 'sbx'), `#!/bin/sh
case "$*" in
  *--help) printf '%s\\n' 'sbx sandbox create --name exec --workdir policy --sandbox rm --force' ;;
  'ls --json') printf '%s\\n' '[{"name":"contrib-1234abcd-1"},{"name":"contrib-1234abcd-0"}]' ;;
  'rm --force contrib-1234abcd-1'|'rm --force contrib-1234abcd-0')
    if [ "$HARNESS_TEST_FAIL_RM" = 1 ]; then printf '%s\\n' 'Fixture removal failed' >&2; exit 1; fi ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  const cli = (args: string[], failRemoval = false) => execute([process.execPath, join(repoRoot, 'dist/src/cli.js'), ...args, '--config', configPath], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HARNESS_TEST_FAIL_RM: failRemoval ? '1' : '0' },
  });
  const result = () => JSON.parse(readFileSync(join(attempt.dir, 'result.json'), 'utf8')) as Attempt;
  const report = () => readFileSync(join(store.dir, 'runs', run.id, 'report.md'), 'utf8');
  const reload = () => new Store(store.dir).state;
  return { store, run, attempt, cli, result, report, reload };
}

test('recover creates missing result artifacts after a crash and permits explicit retry', { skip: process.platform === 'win32' }, async t => {
  const f = recoveryFixture(t);
  const recovered = await f.cli(['recover']);
  assert.equal(recovered.code, 0, recovered.stderr);
  const task = f.reload().tasks[0]!;
  assert.equal(task.status, 'interrupted');
  assert.deepEqual(f.result(), task.attempts[0]); assert.ok(f.result().finishedAt);
  assert.match(f.report(), /\| interrupted \|/);
  assert.equal(readFileSync(join(f.attempt.dir, 'change.patch'), 'utf8'), 'Retained contribution evidence\n');
  assert.equal((await f.cli(['recover'])).code, 0);
  assert.deepEqual(f.result(), task.attempts[0]);
  assert.equal((await f.cli(['retry', task.id])).code, 0);
  assert.equal(f.reload().tasks[0]!.status, 'queued');
});

test('recover refreshes completed run artifacts without moving the latest report backwards', { skip: process.platform === 'win32' }, async t => {
  const f = recoveryFixture(t, true);
  const latest: Run = { id: 'newer-run', startedAt: '2026-01-02T01:00:00.000Z', finishedAt: '2026-01-02T02:00:00.000Z', taskIds: [], tokens: 0, reason: '' };
  f.store.state.runs.push(latest); f.store.save(); writeReport(f.store, latest);
  const recovered = await f.cli(['recover']);
  assert.equal(recovered.code, 0, recovered.stderr);
  const state = f.reload();
  assert.deepEqual(f.result(), state.tasks[0]!.attempts[0]);
  assert.equal(f.result().status, 'interrupted'); assert.equal(f.result().cleanupError, undefined);
  assert.match(f.report(), /\| interrupted \|/);
  assert.equal(state.runs[0]!.finishedAt, f.run.finishedAt);
  assert.match(readFileSync(join(f.store.dir, 'latest-report.md'), 'utf8'), /newer-run/);
});

test('recover records cleanup failures and refreshes the same artifacts on successful recovery', { skip: process.platform === 'win32' }, async t => {
  const f = recoveryFixture(t);
  const failed = await f.cli(['recover'], true);
  assert.equal(failed.code, 1); assert.match(failed.stderr, /Fixture removal failed/);
  const failedTask = f.reload().tasks[0]!;
  assert.equal(failedTask.status, 'failed');
  assert.deepEqual(f.result(), failedTask.attempts[0]); assert.ok(f.result().cleanupError);
  assert.match(f.report(), /\| failed \|/);
  assert.equal((await f.cli(['retry', failedTask.id])).code, 1);

  const recovered = await f.cli(['recover']);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(f.result(), f.reload().tasks[0]!.attempts[0]);
  assert.equal(f.result().status, 'interrupted'); assert.equal(f.result().cleanupError, undefined);
  assert.match(f.report(), /\| interrupted \|/);
  assert.equal((await f.cli(['retry', failedTask.id])).code, 0);
});

test('recover remains retryable when writing a completed run report fails', { skip: process.platform === 'win32' }, async t => {
  const f = recoveryFixture(t, true);
  const reportPath = join(f.store.dir, 'runs', f.run.id, 'report.md');
  rmSync(reportPath); mkdirSync(reportPath);
  const failed = await f.cli(['recover']);
  assert.equal(failed.code, 1);
  // Keep the pending cleanup in durable state until all derived artifacts are written.
  assert.equal(f.reload().tasks[0]!.status, 'failed');
  assert.ok(f.reload().tasks[0]!.attempts[0]!.cleanupError);
  rmSync(reportPath, { recursive: true });
  const recovered = await f.cli(['recover']);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(f.result(), f.reload().tasks[0]!.attempts[0]);
  assert.match(f.report(), /\| interrupted \|/);
});

test('recover tracks orphan scout sandboxes and retains failed cleanup for another recovery', { skip: process.platform === 'win32' }, async t => {
  const f = recoveryFixture(t), id = '2026-01-01T01-00-00-000Z-1234abcd';
  const scout: ScoutRun = { id, dir: join(f.store.dir, 'scouts', id), sandbox: 'contrib-1234abcd-0',
    startedAt: '2026-01-01T01:00:00.000Z', status: 'running', reason: '', tokens: 100, selected: [], assessments: [] };
  f.store.state.scouts = [scout]; f.store.save(); writeScoutReport(scout);
  const failed = await f.cli(['recover'], true);
  assert.equal(failed.code, 1); assert.ok(f.reload().scouts![0]!.cleanupError);
  assert.equal(f.reload().scouts![0]!.status, 'failed');
  const recovered = await f.cli(['recover']);
  assert.equal(recovered.code, 0, recovered.stderr);
  const saved = f.reload().scouts![0]!;
  assert.equal(saved.status, 'interrupted'); assert.equal(saved.cleanupError, undefined);
  assert.match(saved.reason, /rerun scout or night/);
  assert.deepEqual(JSON.parse(readFileSync(join(scout.dir, 'result.json'), 'utf8')), saved);
  assert.match(readFileSync(join(scout.dir, 'report.md'), 'utf8'), /Status: interrupted/);
});
