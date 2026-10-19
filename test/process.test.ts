import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute, sandboxEnvironment } from '../src/process.js';
import { temp } from './helpers.js';

test('passes metacharacters literally and keeps event logs separate from stderr', async t => {
  const dir = temp(t), out = join(dir, 'events.jsonl'), err = join(dir, 'stderr.log');
  const literal = '$(echo bad); `touch nope` "a b"';
  const lines: string[] = [];
  const result = await execute([process.execPath, '-e', 'console.log(JSON.stringify(process.argv[1])); console.error("diagnostic")', literal], { log: out, stderrLog: err, onLine: line => lines.push(line) });
  assert.equal(result.code, 0); assert.equal(JSON.parse(lines[0]!), literal);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')), literal);
  assert.equal(readFileSync(err, 'utf8').trim(), 'diagnostic');
});

test('timeout and cancellation stop processes; output limits fail explicitly', async () => {
  const started = Date.now();
  await assert.rejects(execute([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 80 }), /timeout/);
  assert.ok(Date.now() - started < 4000);
  const controller = new AbortController();
  const running = execute([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(running, /cancelled/);
  await assert.rejects(execute([process.execPath, '-e', 'console.log("x".repeat(10000))'], { maxBytes: 100 }), /output exceeded/);
});

test('cancellation kills a SIGTERM-ignoring descendant after its parent closes', { skip: process.platform === 'win32' }, async t => {
  const heartbeat = join(temp(t), 'heartbeat');
  const controller = new AbortController();
  let descendant: number | undefined;
  const worker = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(process.argv[1], '0');
    let count = 0;
    setInterval(() => fs.writeFileSync(process.argv[1], String(++count)), 20);
    process.send(process.pid);
  `;
  const parent = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', pid => console.log(pid));
    setInterval(() => {}, 1000);
  `;
  try {
    await assert.rejects(execute([process.execPath, '-e', parent, worker, heartbeat], {
      signal: controller.signal, timeoutMs: 10000,
      onLine: line => { descendant = Number(line); controller.abort(); },
    }), /cancelled/);
    assert.ok(descendant && Number.isSafeInteger(descendant));
    await new Promise(resolve => setTimeout(resolve, 100));
    const stopped = readFileSync(heartbeat, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(readFileSync(heartbeat, 'utf8'), stopped, 'Descendant kept working after execute rejected');
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* Already stopped. */ } }
  }
});

test('does not forward host GitHub/SSH/model credentials into sandbox CLI environment', () => {
  const names = ['GH_TOKEN', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'GIT_CONFIG_COUNT'];
  const previous = names.map(k => process.env[k]);
  try {
    names.forEach(k => { process.env[k] = 'test-value'; });
    const env = sandboxEnvironment(); names.forEach(k => assert.equal(env[k], undefined)); assert.ok(env.PATH);
  } finally { names.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; }); }
});
