import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Git } from '../src/git.js';
import { checked } from '../src/process.js';
import type { Config, Issue } from '../src/types.js';

// Compiled test files live in dist/test.
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'contributor-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
export function config(): Config {
  const c = loadConfig(join(repoRoot, 'contributor.config.json'));
  c.author = { name: 'Harness Test', email: 'harness@example.invalid' };
  c.repositories = [{ repo: 'test/library', area: 'typescript', priority: 5 }];
  c.repositoryDiscovery.enabled = false;
  return c;
}
export function issue(number = 1, repo = 'test/library'): Issue {
  return { repo, number, title: 'Negative arguments return the wrong result', body: 'Reproduction: add(1, -2) should be -1.', url: `https://github.com/${repo}/issues/${number}`, state: 'open', labels: ['bug'], assignees: [], updatedAt: new Date().toISOString() };
}
export async function fixture(_source: string, path: string, branch: string, signal: AbortSignal): Promise<Git> {
  mkdirSync(join(path, 'test'), { recursive: true });
  writeFileSync(join(path, 'index.cjs'), 'exports.add = (a, b) => a + Math.abs(b);\n');
  writeFileSync(join(path, 'test/math.test.cjs'), "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('../index.cjs');\ntest('positive', () => assert.equal(add(1, 2), 3));\n");
  await checked(['git', 'init', '--quiet', path], { signal });
  const git = new Git(path);
  await git.run(['add', '--all']);
  await git.run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture baseline']);
  await git.run(['switch', '-c', branch]); return git;
}
