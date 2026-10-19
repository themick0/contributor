import { cpSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checked, execute, sandboxEnvironment, type ProcessOptions } from './process.js';
import type { Config } from './types.js';

const flags = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'diff.external=', '-c', 'credential.helper=', '-c', 'protocol.file.allow=never'];
const environment = () => ({ ...sandboxEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
export class Git {
  readonly repo: string;
  private trustedConfig: Buffer;
  private gitDir: string;
  private agentMetadata = new Map<string, Buffer>();
  constructor(repo: string) {
    // Resolve the trusted checkout root once, before the sandbox can modify it.
    // Keep .git unresolved so metadata symlinks are still rejected by the guards.
    this.repo = realpathSync(repo);
    this.gitDir = resolve(this.repo, '.git');
    this.trustedConfig = readFileSync(resolve(this.gitDir, 'config'));
  }
  private assertMetadata(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Sandbox modified Git metadata: symlink found');
      if (entry.isDirectory()) this.assertMetadata(resolve(path, entry.name));
    }
    if (!readFileSync(resolve(this.gitDir, 'config')).equals(this.trustedConfig)) throw new Error('Git controller configuration changed');
  }
  protectMetadata(): void {
    this.assertMetadata(this.gitDir);
    const head = readFileSync(resolve(this.gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
    if (!ref || ref.split('/').includes('..')) throw new Error('Expected a local task branch');
    for (const path of ['config', 'HEAD', ref]) this.agentMetadata.set(path, readFileSync(resolve(this.gitDir, path)));
    const privateDir = resolve(dirname(this.repo), 'git-host');
    cpSync(this.gitDir, privateDir, { recursive: true, errorOnExist: true, force: false });
    this.gitDir = privateDir;
  }
  async run(args: string[], signal?: AbortSignal, raw = false): Promise<string> {
    const gitDir = this.gitDir;
    if (!lstatSync(gitDir).isDirectory() || realpathSync(gitDir) !== gitDir) throw new Error('Checkout .git must be a local directory');
    this.assertMetadata(gitDir);
    const options: ProcessOptions = { cwd: this.repo, env: environment(), timeoutMs: 60000 };
    if (signal) options.signal = signal;
    const result = await execute(['git', ...flags, `--git-dir=${gitDir}`, `--work-tree=${this.repo}`, ...args], options);
    if (result.code !== 0) throw new Error(`git exited ${result.code}: ${result.stderr.slice(-2000)}`);
    return raw ? result.stdout : result.stdout.trim();
  }
  async disablePush(signal: AbortSignal): Promise<void> {
    await this.run(['remote', 'set-url', '--push', 'origin', 'disabled://local-review-only'], signal);
    this.trustedConfig = readFileSync(resolve(this.gitDir, 'config'));
  }
  async assertHead(base: string): Promise<void> {
    const agentDir = resolve(this.repo, '.git');
    if (!lstatSync(agentDir).isDirectory() || realpathSync(agentDir) !== agentDir) throw new Error('Sandbox changed Git metadata location');
    for (const [path, expected] of this.agentMetadata) {
      const actual = resolve(agentDir, path);
      if (!lstatSync(actual).isFile() || !readFileSync(actual).equals(expected)) throw new Error('Sandbox modified Git configuration or history');
    }
    if (await this.run(['rev-parse', 'HEAD']) !== base) throw new Error('Agent changed Git history');
  }
  async snapshot(): Promise<string> {
    await this.run(['add', '--intent-to-add', '--all']);
    return this.run(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'], undefined, true);
  }
  async assertClean(): Promise<void> {
    if (await this.snapshot()) throw new Error('Read-only or baseline phase changed the checkout');
  }
  async inspect(config: Config): Promise<{ patch: string; files: string[]; lines: number }> {
    const patch = await this.snapshot();
    if (!patch) throw new Error('Empty diff');
    const raw = await this.run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', 'HEAD', '--']);
    let lines = 0; const files: string[] = [];
    for (const entry of raw.split('\0').filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (!match || match[1] === '-' || match[2] === '-') throw new Error('Binary or unsupported diff');
      lines += Number(match[1]) + Number(match[2]); files.push(match[3]!);
    }
    const forbidden = files.find(file => /(^|\/)\.env($|\.)|(^|\/)\.gitmodules$|^\.github\/workflows\/|\.sol$|(^|\/)(id_rsa|id_ed25519)$/.test(file));
    if (forbidden) throw new Error(`Out-of-scope path: ${forbidden}`);
    const modes = await this.run(['diff', '--raw', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--']);
    if (/:\d+ 120000 |:120000 /m.test(modes)) throw new Error('Symlink changes need manual handling');
    if (files.length > config.limits.maxChangedFiles || lines > config.limits.maxChangedLines) throw new Error(`Diff exceeds scope limit: ${files.length} files, ${lines} lines`);
    return { patch, files, lines };
  }
  async commit(author: { name: string; email: string }, title: string): Promise<string> {
    await this.run(['add', '--all']);
    await this.run(['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-m', title]);
    const commit = await this.run(['rev-parse', 'HEAD']);
    if (this.gitDir !== resolve(this.repo, '.git')) {
      // Called only after the VM has been removed. Export trusted Git metadata
      // so the retained checkout opens normally on the user's local branch.
      rmSync(resolve(this.repo, '.git'), { recursive: true });
      cpSync(this.gitDir, resolve(this.repo, '.git'), { recursive: true });
    }
    return commit;
  }
}
export async function clone(repo: string, path: string, branch: string, signal: AbortSignal): Promise<Git> {
  await checked(['git', ...flags, 'clone', '--quiet', '--depth', '1', '--no-tags', '--', `https://github.com/${repo}.git`, path], {
    signal, env: environment(), timeoutMs: 300000,
  });
  const git = new Git(path);
  await git.run(['switch', '-c', branch], signal);
  await git.disablePush(signal);
  return git;
}
export async function resolveAuthor(config: Config, root: string): Promise<{ name: string; email: string }> {
  if (config.author) return config.author;
  const name = await execute(['git', 'config', 'user.name'], { cwd: root });
  const email = await execute(['git', 'config', 'user.email'], { cwd: root });
  if (!name.stdout.trim() || !email.stdout.trim()) throw new Error('Set author.name/email in config, or git config user.name/user.email on the host');
  return { name: name.stdout.trim(), email: email.stdout.trim() };
}
