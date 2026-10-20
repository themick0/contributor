import { execute, type Executor } from './process.js';
import { resolveAuthor } from './git.js';
import type { Config } from './types.js';

export interface Diagnostic { name: string; ok: boolean; detail: string }
export async function sandboxCapabilities(config: Config, run: Executor = execute): Promise<{ forceRemove: boolean }> {
  const prefix = config.sandbox.command;
  const name = prefix.join(' ');
  const hint = 'Check sandbox.command in your config and the selected CLI on your host. For the standalone Docker Sandboxes CLI, set sandbox.command to ["sbx"].';
  const help = async (...args: string[]): Promise<string> => {
    const argv = [...prefix, ...args, '--help'];
    let result;
    try { result = await run(argv, { timeoutMs: 15000 }); }
    catch (error) { throw new Error(`Cannot run ${argv.join(' ')}: ${error instanceof Error ? error.message : String(error)}. ${hint}`); }
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || 'No diagnostic output').slice(-2000);
      throw new Error(`${argv.join(' ')} exited ${result.code}: ${detail}\n${hint}`);
    }
    return `${result.stdout}\n${result.stderr}`;
  };
  const root = await help();
  if (!/\b(?:sandbox(?:es)?|sbx)\b/i.test(root)) throw new Error(`${name} --help did not return Docker Sandboxes help. ${hint}`);
  if (!/\bcreate\b/.test(root)) throw new Error(`${name} does not advertise the required create command. Check the installed Docker Sandboxes CLI version.`);
  for (const [subcommand, required] of [['create', '--name'], ['exec', '--workdir']] as const) {
    if (!(await help(subcommand)).includes(required)) throw new Error(`${name} ${subcommand} must support ${required}`);
  }
  const networkCommand = prefix[0] === 'docker' ? ['network', 'proxy'] : ['policy', 'deny', 'network'];
  const network = await help(...networkCommand);
  const required = prefix[0] === 'docker' ? '--block-host' : '--sandbox';
  if (!network.includes(required)) throw new Error(`${name} ${networkCommand.join(' ')} must support ${required}`);
  const rm = await help('rm');
  return { forceRemove: rm.includes('--force') };
}
export async function doctor(config: Config, root: string, run: Executor = execute, githubLogin?: () => Promise<string>): Promise<Diagnostic[]> {
  const result: Diagnostic[] = [{ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version }];
  for (const [name, action] of [
    ['Git', async () => { const r = await run(['git', '--version']); if (r.code) throw new Error(r.stderr); return r.stdout.trim(); }],
    ['GitHub', async () => { if (githubLogin) return `API access verified (${await githubLogin()})`; const r = await run(['gh', 'api', '--method', 'GET', 'user', '--jq', '.login'], { timeoutMs: 20000 }); if (r.code || !r.stdout.trim()) throw new Error('GitHub API request failed. Authenticate gh on the host; check GH_TOKEN/GITHUB_TOKEN overrides and network access.'); return `API access verified (${r.stdout.trim()})`; }],
    ['Commit author', async () => { const a = await resolveAuthor(config, root); return `${a.name} <${a.email}>`; }],
    ['Docker Sandboxes', async () => { await sandboxCapabilities(config, run); return config.sandbox.command.join(' ') + ' create/exec/network/rm available'; }],
  ] as const) {
    try { result.push({ name, ok: true, detail: await action() }); }
    catch (error) { result.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return result;
}
