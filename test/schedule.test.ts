import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from '../src/process.js';
import { writeSchedule } from '../src/schedule.js';
import { Store } from '../src/store.js';
import { config, repoRoot, temp } from './helpers.js';

test('generated cron runs with user-installed tools and a minimal scheduler PATH', { skip: process.platform === 'win32' }, async t => {
  const root = join(temp(t), "cron 100% 'night'");
  const bin = join(root, "tools % 'local'"), cronBin = join(root, 'cron-bin');
  mkdirSync(bin, { recursive: true }); mkdirSync(cronBin);
  const c = config(); c.stateDir = 'state'; c.sandbox.command = ['sbx'];
  const configPath = join(root, 'config.json'); writeFileSync(configPath, JSON.stringify(c));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$4" in
  user) printf '%s\\n' '{"login":"fixture-user"}' ;;
  repos/test/library) printf '%s\\n' '{"archived":false,"disabled":false}' ;;
  search/issues) printf '%s\\n' '{"items":[]}' ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  writeFileSync(join(bin, 'sbx'), `#!/bin/sh
case "$*" in
  *--help) printf '%s\\n' 'sbx sandbox create --name exec --workdir policy --sandbox rm --force' ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  const savedPath = process.env.PATH;
  const userPath = `${bin}:${savedPath ?? '/usr/local/bin:/usr/bin:/bin'}`;
  const stateDir = join(root, c.stateDir);
  try {
    process.env.PATH = userPath;
    writeSchedule(stateDir, root, configPath, 1);
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  }
  const interactive = await execute([process.execPath, join(repoRoot, 'dist/src/cli.js'), 'doctor', '--config', configPath], { env: { ...process.env, PATH: userPath } });
  assert.equal(interactive.code, 0, interactive.stdout + interactive.stderr);

  // Cron removes the five time fields and unescapes percent signs before invoking its shell.
  const line = readFileSync(join(stateDir, 'schedule/night.cron'), 'utf8').trim();
  const command = line.replace(/^(?:\S+\s+){5}/, '').replace(/\\%/g, '%');
  const scheduled = await execute(['/bin/sh', '-c', command], { env: { ...process.env, PATH: cronBin } });
  const log = readFileSync(join(stateDir, 'scheduler.log'), 'utf8');
  assert.equal(scheduled.code, 0, log + scheduled.stderr);
  assert.match(log, /Queued 0 new issues/);
  const state = new Store(stateDir).state;
  assert.equal(state.runs.length, 1); assert.ok(state.runs[0]!.finishedAt);
  assert.equal(state.tasks.length, 0);
});
