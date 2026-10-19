import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from '../src/git.js';
import { fixture, temp } from './helpers.js';

test('Git supports trusted parent symlinks through metadata protection and commit export', { skip: process.platform === 'win32' }, async t => {
  const dir = temp(t), physical = join(dir, 'private'), alias = join(dir, 'var');
  mkdirSync(physical); symlinkSync(physical, alias, 'dir');
  const repo = join(alias, 'repo');
  const git = await fixture('', repo, 'contrib/symlink-parent', new AbortController().signal);
  assert.equal(git.repo, realpathSync(repo));
  const base = await git.run(['rev-parse', 'HEAD']); git.protectMetadata();
  appendFileSync(join(repo, 'index.cjs'), '// fixture change\n');
  await git.assertHead(base); assert.match(await git.snapshot(), /fixture change/);
  const commit = await git.commit({ name: 'Fixture', email: 'fixture@example.invalid' }, 'test: canonical checkout');
  assert.notEqual(commit, base);
  const reopened = new Git(repo);
  assert.equal(await reopened.run(['rev-parse', 'HEAD']), commit); await reopened.assertClean();
});

test('Git still rejects symlinks replacing the checkout metadata', { skip: process.platform === 'win32' }, async t => {
  const git = await fixture('', join(temp(t), 'repo'), 'contrib/metadata-symlink', new AbortController().signal);
  const base = await git.run(['rev-parse', 'HEAD']); git.protectMetadata();
  const metadata = join(git.repo, '.git'), moved = join(git.repo, 'metadata');
  renameSync(metadata, moved); symlinkSync(moved, metadata, 'dir');
  await assert.rejects(git.assertHead(base), /changed Git metadata location/);
  await assert.rejects(async () => new Git(git.repo).run(['rev-parse', 'HEAD']), /local directory/);
  assert.equal(await git.run(['rev-parse', 'HEAD']), base);
});
