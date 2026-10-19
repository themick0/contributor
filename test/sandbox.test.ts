import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DockerSandbox } from '../src/sandbox.js';
import { doctor, sandboxCapabilities } from '../src/doctor.js';
import { workSchema } from '../src/schemas.js';
import type { Executor, ProcessOptions } from '../src/process.js';
import { config, temp } from './helpers.js';

test('native Docker Sandbox adapter mounts only job dirs and feeds prompts through stdin', async t => {
  const dir = temp(t), calls: { argv: string[]; options: ProcessOptions }[] = [];
  const c = config(); c.sandbox.command = ['docker', 'sandbox'];
  const run: Executor = async (argv, options = {}) => {
    calls.push({ argv, options });
    if (argv.includes('--help')) return { code: 0, stdout: '--json --output-schema', stderr: '' };
    if (options.onLine) {
      options.onLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"status":"done","summary":"ok"}' } }));
      options.onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 30, output_tokens: 10 } }));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const sb = new DockerSandbox({ name: 'contrib-12345678-1', repo: join(dir, 'repo with space'), control: join(dir, 'control'), logs: join(dir, 'logs'), config: c, forceRemove: true }, run);
  const signal = new AbortController().signal;
  await sb.create(signal);
  const prompt = 'Fix literal $(never execute this)';
  const response = await sb.agent('test', prompt, workSchema, signal);
  assert.equal(response.tokens, 60);
  const creation = calls[0]!.argv;
  assert.deepEqual(creation.slice(0, 3), ['docker', 'sandbox', 'create']);
  assert.equal(creation.at(-1), join(dir, 'control') + ':ro');
  assert.ok(calls[1]!.argv.includes('--block-host'));
  const agent = calls.find(c => c.options.onLine)!;
  assert.equal(agent.options.input, prompt); assert.ok(agent.argv.includes('-i'));
  assert.ok(!agent.argv.includes(prompt)); assert.equal(agent.argv.at(-1), '-');
  await sb.remove(); assert.ok(calls.at(-1)!.argv.includes('--force'));
});

test('requires successful terminal event and a valid structured final response', async t => {
  const dir = temp(t), c = config();
  const sb = new DockerSandbox({ name: 'contrib-12345678-1', repo: dir, control: dir, logs: dir, config: c }, async (_argv, options) => {
    options?.onLine?.('{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}');
    return { code: 0, stdout: '', stderr: '' };
  });
  await assert.rejects(sb.agent('test', 'prompt', workSchema, new AbortController().signal), /did not complete/);
});

test('generic docker --help returning zero does not pass preflight', async () => {
  const c = config(); c.sandbox.command = ['docker', 'sandbox'];
  await assert.rejects(sandboxCapabilities(c, async () => ({ code: 0, stdout: 'Docker commands: run build create', stderr: '' })), /did not return Docker Sandboxes help.*sandbox.command/);
});

test('sbx preflight accepts help on either stream without requiring an existing sandbox', async () => {
  const c = config(); c.sandbox.command = ['sbx'];
  const output = new Map([
    ['sbx --help', 'Usage: sbx COMMAND\nCommands: create exec policy rm'],
    ['sbx create --help', 'Create a sandbox: --name'],
    ['sbx exec --help', 'Execute a command: --workdir'],
    ['sbx policy deny network --help', 'Deny a host: --sandbox'],
    ['sbx rm --help', 'Remove a sandbox: --force'],
  ]);
  for (const stream of ['stdout', 'stderr'] as const) {
    const calls: string[] = [];
    const result = await sandboxCapabilities(c, async argv => {
      const command = argv.join(' '); calls.push(command);
      assert.ok(output.has(command), `Unexpected command: ${command}`);
      return { code: 0, stdout: '', stderr: '', [stream]: output.get(command)! };
    });
    assert.deepEqual(result, { forceRemove: true });
    assert.deepEqual(calls, [...output.keys()]);
  }
});

test('preflight preserves failed CLI command, exit code, and diagnostic output', async () => {
  const c = config(); c.sandbox.command = ['sbx'];
  for (const command of ['sbx --help', 'sbx policy deny network --help']) {
    await assert.rejects(sandboxCapabilities(c, async argv => argv.join(' ') === command
      ? { code: 2, stdout: '', stderr: 'Cannot connect to sandboxd' }
      : { code: 0, stdout: 'sbx create --name --workdir --sandbox --force', stderr: '' }), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`${command} exited 2: Cannot connect to sandboxd`));
      assert.match(error.message, /sandbox.command/);
      assert.doesNotMatch(error.message, /outside the agent sandbox/);
      return true;
    });
  }
});

test('preflight distinguishes a missing CLI from an unsupported sandbox CLI version', async () => {
  const c = config(); c.sandbox.command = ['sbx'];
  await assert.rejects(sandboxCapabilities(c, async () => { throw new Error('spawn sbx ENOENT'); }), /Cannot run sbx --help: spawn sbx ENOENT.*sandbox.command/);
  await assert.rejects(sandboxCapabilities(c, async () => ({ code: 0, stdout: 'sbx commands: run ls rm', stderr: '' })), /sbx does not advertise the required create command/);
});

test('doctor verifies API access instead of trusting a cached authentication status', async () => {
  const calls: string[][] = [];
  const checks = await doctor(config(), '.', async argv => {
    calls.push(argv);
    return argv[0] === 'gh' && argv[1] === 'api'
      ? { code: 1, stdout: '', stderr: 'HTTP 401' }
      : { code: 0, stdout: 'sandbox create --name --workdir --sandbox --force', stderr: '' };
  });
  assert.equal(checks.find(c => c.name === 'GitHub')?.ok, false);
  assert.ok(calls.some(a => a.join(' ') === 'gh api --method GET user --jq .login'));
});

test('sbx adapter uses the documented scoped policy and removal commands', async t => {
  const dir = temp(t), c = config(); c.sandbox.command = ['sbx'];
  const calls: string[][] = [];
  const sb = new DockerSandbox({ name: 'contrib-12345678-1', repo: dir, control: dir, logs: dir, config: c, forceRemove: true }, async argv => {
    calls.push(argv); return { code: 0, stdout: '--json --output-schema', stderr: '' };
  });
  await sb.create(new AbortController().signal); await sb.remove();
  assert.ok(calls.some(a => a.join(' ') === 'sbx policy deny network --sandbox contrib-12345678-1 api.github.com'));
  assert.deepEqual(calls.at(-1), ['sbx', 'rm', '--force', 'contrib-12345678-1']);
});
