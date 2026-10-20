import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHubApi, type GitHubApiOptions } from '../src/github-api.js';
import { GitHubClient } from '../src/github.js';
import type { ProcessResult } from '../src/process.js';
import { config, issue, temp } from './helpers.js';

function response(data: unknown, status = 200, headers: Record<string, string> = {}): ProcessResult {
  return { code: status >= 400 ? 1 : 0, stdout: [`HTTP/2.0 ${status}`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', JSON.stringify(data)].join('\r\n'), stderr: '' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function clock() {
  let time = Date.UTC(2026, 0, 1);
  const sleeps: number[] = [], logs: string[] = [];
  const options: GitHubApiOptions = {
    now: () => time,
    sleep: async milliseconds => { assert.ok(milliseconds > 0 && milliseconds <= 60000); sleeps.push(milliseconds); time += milliseconds; },
    log: message => logs.push(message),
  };
  return { options, sleeps, logs, now: () => time };
}

test('search fetches explicit pages through the paced client and caches repository availability', async () => {
  const time = clock(), calls: string[][] = [];
  const client = new GitHubClient(async argv => {
    calls.push(argv);
    if (argv[4] === 'repos/test/library') return response({ archived: false, disabled: false });
    assert.equal(argv[4], 'search/issues');
    assert.ok(argv.includes('per_page=2'));
    const number = argv.includes('page=2') ? 3 : 1;
    const current = issue(number);
    return response({ items: [{ ...current, html_url: current.url, labels: [], assignees: [], updated_at: current.updatedAt }] });
  }, undefined, time.options);
  assert.equal((await client.search('test/library', 2, 1))[0]!.number, 1);
  assert.equal((await client.search('TEST/Library', 2, 2))[0]!.number, 3);
  assert.equal(calls.filter(argv => argv[4]!.startsWith('repos/')).length, 1);
  assert.equal(calls.length, 3);
  await assert.rejects(client.search('test/library', 100, 11), /Invalid GitHub search/);
  assert.equal(calls.length, 3);
});

test('secondary rate limits wait a minute and back off before recovering', async () => {
  const time = clock(), started = time.now(), calls: number[] = [];
  const api = new GitHubApi(async () => {
    calls.push(time.now());
    return calls.length < 3 ? response({ message: 'You have exceeded a secondary rate limit.' }, 403) : response({ ok: true });
  }, undefined, time.options);
  assert.deepEqual((await api.request('repos/test/library')).data, { ok: true });
  assert.deepEqual(calls.map(at => at - started), [0, 60000, 180000]);
  assert.match(time.logs[0]!, /waiting 60s before retry 1\/5/);
  assert.match(time.logs[1]!, /waiting 120s before retry 2\/5/);
});

test('Retry-After and primary reset headers are respected, including server clock skew', async () => {
  const start = Date.UTC(2026, 0, 1), server = start + 300000;
  const cases: { headers: Record<string, string>; wait: number }[] = [
    { headers: { 'Retry-After': '12' }, wait: 12000 },
    { headers: { Date: new Date(server).toUTCString(), 'Retry-After': new Date(server + 90000).toUTCString() }, wait: 90000 },
    { headers: { Date: new Date(server).toUTCString(), 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String((server + 90000) / 1000) }, wait: 91000 },
    { headers: { 'Retry-After': '120', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String((start + 90000) / 1000) }, wait: 120000 },
  ];
  for (const example of cases) {
    const time = clock(); let calls = 0;
    const api = new GitHubApi(async () => ++calls === 1 ? response({ message: 'Rate limited' }, 429, example.headers) : response({ ok: true }), undefined, time.options);
    await api.request('user');
    assert.equal(time.now() - start, example.wait);
    assert.equal(calls, 2);
  }
});

test('GitHub requests are serialized and search requests are paced separately', async () => {
  const time = clock(), started = time.now(), starts: number[] = [];
  let active = 0, peak = 0;
  const api = new GitHubApi(async () => {
    active++; peak = Math.max(peak, active); starts.push(time.now());
    await Promise.resolve(); active--;
    return response({ ok: true });
  }, undefined, time.options);
  await Promise.all([api.request('search/issues'), api.request('search/issues'), api.request('repos/test/library')]);
  assert.equal(peak, 1);
  assert.deepEqual(starts.map(at => at - started), [0, 3000, 4000]);
});

test('cooldown survives cancellation and is honored by a new client', async t => {
  const time = clock(), started = time.now(), controller = new AbortController();
  const cooldownPath = join(temp(t), 'github-cooldown.json');
  const api = new GitHubApi(async () => response({ message: 'secondary rate limit' }, 403), controller.signal, {
    ...time.options, cooldownPath, log: () => controller.abort(),
  });
  await assert.rejects(api.request('user'), { name: 'AbortError' });
  assert.equal(JSON.parse(readFileSync(cooldownPath, 'utf8')).until, started + 60000);
  const resumed = new GitHubApi(async () => {
    assert.ok(time.now() >= started + 60000); return response({ login: 'fixture-user' });
  }, undefined, { ...time.options, cooldownPath });
  await resumed.request('user');
  assert.equal(time.now(), started + 60000);
});

test('using the last primary quota delays the next request even after a successful response', async () => {
  const time = clock(), started = time.now(); let calls = 0;
  const api = new GitHubApi(async () => ++calls === 1
    ? response({ ok: true }, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((started + 10000) / 1000) })
    : response({ ok: true }), undefined, time.options);
  await api.request('one'); await api.request('two');
  assert.equal(time.now() - started, 11000);
});

test('exhausted rate-limit retries stop queued requests and retain the next cooldown', async t => {
  const time = clock(), started = time.now(), cooldownPath = join(temp(t), 'github-cooldown.json'); let calls = 0;
  const api = new GitHubApi(async () => { calls++; return response({ message: 'secondary rate limit' }, 403); }, undefined, { ...time.options, cooldownPath });
  const results = await Promise.allSettled([api.request('one'), api.request('two')]);
  assert.equal(calls, 6);
  assert.equal(time.now() - started, 1860000);
  assert.ok(results.every(result => result.status === 'rejected' && /rate limit after 5 retries/.test(String(result.reason))));
  assert.match(api.stopReason!, /rate limit after 5 retries/);
  assert.equal(JSON.parse(readFileSync(cooldownPath, 'utf8')).until, time.now() + 1920000);
});

test('authentication, permission, and not-found errors are not retried', async () => {
  for (const status of [401, 403, 404, 422]) {
    const time = clock(); let calls = 0;
    const api = new GitHubApi(async () => { calls++; return response({ message: 'Access denied' }, status); }, undefined, time.options);
    await assert.rejects(api.request('user'), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1); assert.deepEqual(time.sleeps, []);
  }
});

test('temporary transport and server failures retry safe GET requests', async () => {
  const time = clock(), started = time.now(); let calls = 0;
  const api = new GitHubApi(async () => {
    if (++calls === 1) throw new Error('Process timeout after 45000ms');
    return calls === 2 ? response({ message: 'Service unavailable' }, 503) : response({ ok: true });
  }, undefined, time.options);
  await api.request('user');
  assert.equal(calls, 3); assert.equal(time.now() - started, 15000);
});

test('the default cooldown wait can be interrupted without another request', async () => {
  const controller = new AbortController(), waiting = deferred<void>(); let calls = 0;
  const api = new GitHubApi(async () => { calls++; return response({ message: 'secondary rate limit' }, 403); }, controller.signal, {
    log: () => waiting.resolve(),
  });
  const pending = api.request('user');
  await waiting.promise; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('cancelling a queued task returns promptly and never issues its request', async () => {
  const time = clock(), entered = deferred<void>(), release = deferred<ProcessResult>();
  const calls: string[] = [], controller = new AbortController();
  const api = new GitHubApi(async argv => {
    calls.push(argv[4]!);
    if (argv[4] === 'one') { entered.resolve(); return release.promise; }
    return response({ ok: true });
  }, undefined, time.options);
  const first = api.request('one'); await entered.promise;
  const cancelled = api.request('two', [], controller.signal); controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  release.resolve(response({ ok: true })); await first; await api.request('three');
  assert.deepEqual(calls, ['one', 'three']);
});

test('GitHub context follows Link pages and retries only the throttled page', async () => {
  const time = clock(), calls: string[][] = [];
  const raw = { number: 1, title: 'Bug', body: 'repro', html_url: issue().url, state: 'open', labels: [{ name: 'bug' }], assignees: [], updated_at: '2026-01-01' };
  let secondPageCalls = 0;
  const github = new GitHubClient(async argv => {
    calls.push(argv); const path = argv[4]!;
    if (path.endsWith('/timeline?per_page=100')) return response([], 200, { Link: '<https://api.github.com/repos/test/library/issues/1/timeline?per_page=100&page=2>; rel="next"' });
    if (path.includes('/timeline?')) {
      if (++secondPageCalls === 1) return response({ message: 'secondary rate limit' }, 403);
      return response([{ event: 'cross-referenced', source: { issue: { ...raw, pull_request: {}, html_url: 'https://github.com/test/library/pull/7' } } }]);
    }
    if (path.endsWith('/comments?per_page=100')) return response(Array.from({ length: 26 }, (_, i) => ({ user: { login: 'maintainer' }, body: `Note ${i}` })), 200, { Link: '<https://api.github.com/repos/test/library/issues/1/comments?per_page=100&page=2>; rel="next"' });
    if (path.includes('/comments?')) return response([{ user: { login: 'maintainer' }, body: 'Confirmed' }]);
    return response(raw);
  }, undefined, time.options);
  const context = await github.context('test/library', 1);
  assert.deepEqual(context.openPullRequests, ['https://github.com/test/library/pull/7']);
  assert.equal(context.comments.length, 25); assert.equal(context.comments[0], 'maintainer: Note 2');
  assert.equal(context.comments.at(-1), 'maintainer: Confirmed');
  assert.equal(calls.filter(argv => argv[4]!.endsWith('/timeline?per_page=100')).length, 1);
  assert.equal(secondPageCalls, 2);
  assert.ok(calls.every(argv => argv.includes('GET') && argv.includes('--include') && !argv.includes('--paginate')));
});

test('pagination does not follow another host or loop over the same page', async () => {
  for (const link of ['https://evil.invalid/issues?page=2', 'https://api.github.com/repos/test/library/issues/1/timeline?per_page=100']) {
    const time = clock(); let calls = 0;
    const raw = { number: 1, title: 'Bug', body: 'repro', html_url: issue().url, state: 'open', labels: [], assignees: [], updated_at: '2026-01-01' };
    const github = new GitHubClient(async () => ++calls === 1 ? response(raw) : response([], 200, { Link: `<${link}>; rel="next"` }), undefined, time.options);
    await assert.rejects(github.context('test/library', 1), /pagination host|pagination loop/);
    assert.equal(calls, 2);
  }
});

test('repository research fetches bounded source evidence through GETs and preserves current metadata', async () => {
  const time = clock(), calls: string[][] = [];
  const raw = { full_name: 'test/library', description: 'A frontend package', stargazers_count: 8000, pushed_at: '2026-01-01T00:00:00Z',
    archived: false, disabled: false, fork: false, private: false, language: 'TypeScript', license: { spdx_id: 'MIT' }, topics: ['frontend'] };
  const client = new GitHubClient(async argv => {
    calls.push(argv); const path = argv[4]!;
    if (path === 'search/repositories') {
      assert.ok(argv.includes('q=topic:frontend')); assert.ok(argv.includes('per_page=10'));
      return response({ items: [raw] });
    }
    if (path === 'repos/test/library') return response(raw);
    if (path.endsWith('/languages')) return response({ TypeScript: 50000, JavaScript: 1000 });
    if (path.endsWith('/readme')) return response({ type: 'file', encoding: 'base64', content: Buffer.from('A frontend library.\n' + 'x'.repeat(7000)).toString('base64') });
    if (path.endsWith('/contents/AGENTS.md')) return response({ type: 'symlink', encoding: 'base64', content: Buffer.from('Not a regular file').toString('base64') });
    if (path.includes('/contents/')) return response({ message: 'Not Found' }, 404);
    if (path === 'search/issues') {
      assert.ok(argv.includes('per_page=20'));
      const current = issue();
      return response({ items: [{ ...current, body: 'a'.repeat(2500), html_url: current.url, labels: [], assignees: [], updated_at: current.updatedAt }] });
    }
    if (path.includes('/pulls?')) return response([{ title: 'A merged fix', html_url: 'https://github.com/test/library/pull/2', merged_at: '2026-01-01', updated_at: '2026-01-01', author_association: 'CONTRIBUTOR', body: 'Discard long PR bodies' }]);
    throw new Error(`Unexpected request: ${path}`);
  }, undefined, time.options);
  assert.equal((await client.searchRepositories('topic:frontend', 10))[0]!.stars, 8000);
  const facts = await client.repositoryFacts('test/library');
  const details = await client.repositoryEvidence(facts, config());
  assert.deepEqual(details.languages, ['TypeScript', 'JavaScript']); assert.equal(details.facts.license, 'MIT');
  assert.match(details.sources.README!, /Source excerpt truncated/); assert.ok(details.sources.README!.length < 6100);
  assert.equal(details.sources['CONTRIBUTING.md'], undefined); assert.equal(details.sources['AGENTS.md'], undefined);
  assert.equal(details.issues[0]!.body.length, 1500);
  assert.equal(JSON.parse(details.sources.recent_pull_requests!)[0].mergedAt, '2026-01-01');
  assert.doesNotMatch(details.sources.recent_pull_requests!, /Discard long/);
  assert.equal(calls.filter(argv => argv[4] === 'repos/test/library').length, 1);
  assert.ok(calls.every(argv => argv.includes('GET')));
});

test('repository research stops early for non-JS projects and does not hide authorization errors as missing policy', async () => {
  for (const javascript of [false, true]) {
    const time = clock(), calls: string[] = [];
    const client = new GitHubClient(async argv => {
      const path = argv[4]!; calls.push(path);
      if (path.endsWith('/languages')) return response(javascript ? { JavaScript: 500 } : { Rust: 500 });
      return response({ message: 'Forbidden' }, 403);
    }, undefined, time.options);
    const facts = { repo: 'test/library', description: '', stars: 1000, pushedAt: '2026-01-01', archived: false, disabled: false, fork: false, private: false, language: null, license: null, topics: [] };
    if (javascript) await assert.rejects(client.repositoryEvidence(facts, config()), /HTTP 403/);
    else { assert.deepEqual((await client.repositoryEvidence(facts, config())).issues, []); assert.equal(calls.length, 1); }
  }
});

test('repository research finds eligible issues beyond the five-item sample and bounds further pages', async () => {
  for (const mode of ['sixth', 'next-page', 'none', 'enough', 'cancelled'] as const) {
    const c = config(), time = clock(), pages: number[] = [], controller = new AbortController();
    const facts = { repo: 'test/library', description: '', stars: 20000, pushedAt: new Date().toISOString(), archived: false, disabled: false, fork: false, private: false, language: 'TypeScript', license: 'MIT', topics: [] };
    const client = new GitHubClient(async argv => {
      const path = argv[4]!;
      if (path === 'repos/test/library') return response({ archived: false, disabled: false });
      if (path.endsWith('/languages')) return response({ TypeScript: 5000 });
      if (path.includes('/contents/') || path.endsWith('/readme')) return response({ message: 'Not Found' }, 404);
      if (path.includes('/pulls?')) return response([]);
      if (path === 'search/issues') {
        const page = Number(argv.find(arg => arg.startsWith('page='))!.slice(5)); pages.push(page);
        assert.ok(argv.includes('per_page=20'));
        if (mode === 'cancelled') controller.abort();
        const size = mode === 'sixth' ? 6 : mode === 'next-page' && page === 2 ? 1 : 20;
        return response({ items: Array.from({ length: size }, (_, i) => {
          const number = (page - 1) * 20 + i + 1, current = issue(number);
          const allowed = mode === 'sixth' && number === 6 || mode === 'next-page' && number === 21 || mode === 'enough';
          return { ...current, html_url: current.url, updated_at: current.updatedAt, labels: [{ name: allowed ? 'bug' : 'duplicate' }] };
        }) });
      }
      throw new Error(`Unexpected request: ${path}`);
    }, undefined, time.options);
    if (mode === 'cancelled') {
      await assert.rejects(client.repositoryEvidence(facts, c, controller.signal), /abort|cancel/i);
      assert.deepEqual(pages, [1]); continue;
    }
    const evidence = await client.repositoryEvidence(facts, c);
    assert.deepEqual(pages, mode === 'next-page' ? [1, 2] : mode === 'none' ? [1, 2, 3] : [1]);
    if (mode === 'sixth' || mode === 'next-page') assert.deepEqual(evidence.issues.map(current => current.number), [mode === 'sixth' ? 6 : 21]);
    else assert.equal(evidence.issues.length, mode === 'none' ? 0 : 5);
    const sampling = JSON.parse(evidence.sources.issue_sampling!);
    assert.equal(sampling.pages, pages.length); assert.equal(sampling.sampleSize, evidence.issues.length);
    assert.ok(sampling.inspected <= 60); assert.equal(evidence.facts.stars, 20000);
  }
});
