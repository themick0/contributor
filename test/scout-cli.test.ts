import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from '../src/process.js';
import { atomicJson, Store } from '../src/store.js';
import { config, issue, repoRoot, temp } from './helpers.js';

test('night discovers new repositories through two sandbox sessions and reuses their catalog on the next invocation', { skip: process.platform === 'win32' }, async t => {
  const root = temp(t), bin = join(root, 'bin'); mkdirSync(bin);
  const c = config(); c.stateDir = 'state'; c.sandbox.command = ['sbx']; c.repositoryDiscovery.enabled = true;
  const configPath = join(root, 'config.json'); atomicJson(configPath, c);
  const current = issue(1, 'new/library');
  atomicJson(join(root, 'fixture.json'), {
    metadata: { full_name: 'new/library', description: 'A TypeScript frontend library', stargazers_count: 4000, pushed_at: new Date().toISOString(),
      archived: false, disabled: false, private: false, fork: false, language: 'TypeScript', license: { spdx_id: 'MIT' }, topics: ['frontend'] },
    issue: { ...current, html_url: current.url, updated_at: current.updatedAt, labels: [], assignees: [] },
    readme: 'A TypeScript library for frontend state management.',
    plan: { queries: [{ area: 'frontend', query: 'topic:frontend language:TypeScript' }] },
    selection: { repositories: [{ repo: 'new/library', decision: 'select', area: 'frontend', priority: 4,
      reason: 'A relevant library with an open bug report.', policy: 'unspecified', evidence: [
        { source: 'README', quote: 'A TypeScript library for frontend state management.' },
        { source: 'open_issues', quote: current.title },
      ] }] },
  });
  const common = `const fs = require('node:fs'), path = require('node:path');
const root = path.dirname(__dirname), args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({tool: path.basename(process.argv[1]), args}) + '\\n');
const send = value => console.log(JSON.stringify(value));
`;
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
${common}
if (args[0] !== 'api' || args[2] !== 'GET') process.exit(64);
const endpoint = args[3];
if (endpoint === 'user') send({login: 'fixture-user'});
else if (endpoint === 'search/repositories') send({items: data.emptySearch ? [] : [data.metadata]});
else if (endpoint === 'repos/new/library') send(data.metadata);
else if (endpoint === 'repos/test/library') send({archived:false,disabled:false});
else if (endpoint.endsWith('/languages')) send({TypeScript: 10000});
else if (endpoint.endsWith('/readme')) send({type:'file',encoding:'base64',content:Buffer.from(data.readme).toString('base64')});
else if (endpoint.includes('/contents/')) { console.log('HTTP/2.0 404\\n\\n{"message":"Not Found"}'); process.exitCode = 1; }
else if (endpoint === 'search/issues') send({items: args.includes('per_page=20') ? [data.issue] : []});
else if (endpoint.endsWith('/comments?per_page=100') || endpoint.endsWith('/timeline?per_page=100')) send([]);
else if (endpoint.startsWith('repos/new/library/issues/')) send({...data.issue, number: Number(endpoint.split('/').pop()), state: 'closed'});
else if (endpoint.includes('/pulls?')) send([]);
else process.exit(64);
`, { mode: 0o700 });
  writeFileSync(join(bin, 'sbx'), `#!/usr/bin/env node
${common}
if (args.includes('--help')) console.log('sbx sandbox create --name exec --workdir policy --sandbox rm --force --json --output-schema');
else if (['create','policy','rm'].includes(args[0])) {}
else if (args[0] === 'exec') {
  const schema = args[args.indexOf('--output-schema') + 1];
  const stage = path.basename(schema).replace('.schema.json','');
  const prompt = fs.readFileSync(0,'utf8');
  if (!prompt.includes('English')) process.exit(65);
  if (stage === 'scout-select' && !fs.existsSync(path.join(path.dirname(schema), 'evidence.json'))) process.exit(66);
  const value = stage === 'scout-plan' ? data.plan : data.selection;
  send({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}});
  send({type:'turn.completed',usage:{input_tokens:10,output_tokens:1}});
} else process.exit(64);
`, { mode: 0o700 });
  const cli = (args: string[]) => execute([process.execPath, join(repoRoot, 'dist/src/cli.js'), ...args, '--config', configPath], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeoutMs: 60000,
  });
  const calls = () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { tool: string; args: string[] });
  const first = await cli(['night']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Repository scout: ready/); assert.match(first.stdout, /new\/library: 0 issues inspected/);
  let state = new Store(join(root, 'state')).state;
  assert.equal(state.scouts!.length, 1); assert.equal(state.scouts![0]!.status, 'ready');
  assert.equal(state.runs[0]!.tokens, 22); assert.equal(state.runs[0]!.scoutDir, state.scouts![0]!.dir);
  assert.equal(calls().filter(call => call.tool === 'sbx' && call.args.includes('--output-schema')).length, 2);
  assert.equal(calls().filter(call => call.tool === 'sbx' && call.args[0] === 'create' && !call.args.includes('--help')).length, 1);
  assert.equal(readFileSync(configPath, 'utf8'), JSON.stringify(c, null, 2) + '\n');

  const second = await cli(['night']);
  assert.equal(second.code, 0, second.stdout + second.stderr); assert.match(second.stdout, /using 1 cached targets/);
  state = new Store(join(root, 'state')).state;
  assert.equal(state.scouts!.length, 1); assert.equal(state.runs[1]!.tokens, 0);
  assert.equal(calls().filter(call => call.tool === 'sbx' && call.args.includes('--output-schema')).length, 2);
  const before = calls().length;
  const preview = await cli(['run', '--dry-run']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).repositories, ['test/library', 'new/library']);
  assert.equal(calls().length, before);

  const backlog = new Store(join(root, 'state')); backlog.enqueue(current, 90);
  const fixturePath = join(root, 'fixture.json');
  atomicJson(fixturePath, { ...JSON.parse(readFileSync(fixturePath, 'utf8')), emptySearch: true });
  const rotation = await cli(['scout']);
  assert.equal(rotation.code, 0, rotation.stdout + rotation.stderr);
  const catalog = JSON.parse(readFileSync(join(root, 'state', 'repositories.json'), 'utf8'));
  assert.deepEqual(catalog.repositories, []);
  assert.deepEqual(catalog.retainedRepositories.map((repo: { repo: string }) => repo.repo), ['new/library']);
  const retainedPreview = await cli(['run', '--dry-run']);
  assert.deepEqual(JSON.parse(retainedPreview.stdout).tasks, ['new/library#1']);

  // A full retained queue is processed before night refills current targets.
  c.discovery.maxQueued = 1; atomicJson(configPath, c);
  const beforeNight = calls().length, retainedNight = await cli(['night']);
  assert.equal(retainedNight.code, 0, retainedNight.stdout + retainedNight.stderr);
  state = new Store(join(root, 'state')).state;
  assert.deepEqual(state.runs.at(-1)!.taskIds, ['new/library#1']);
  assert.equal(state.tasks[0]!.status, 'skipped'); assert.match(state.tasks[0]!.reason, /closed/);
  const nightSearches = calls().slice(beforeNight).filter(call => call.tool === 'gh' && call.args.includes('search/issues'));
  assert.equal(nightSearches.length, 1); assert.ok(nightSearches[0]!.args.some(arg => arg.startsWith('q=repo:test/library ')));

  const remaining = new Store(join(root, 'state')); remaining.enqueue(issue(2, 'new/library'), 80);
  const beforeRun = calls().length, retainedRun = await cli(['run']);
  assert.equal(retainedRun.code, 0, retainedRun.stdout + retainedRun.stderr);
  assert.deepEqual(new Store(join(root, 'state')).state.runs.at(-1)!.taskIds, ['new/library#2']);
  assert.equal(calls().slice(beforeRun).filter(call => call.tool === 'gh' && call.args.includes('search/issues')).length, 0);
});
