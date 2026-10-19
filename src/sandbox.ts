import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandPath } from './config.js';
import { checked, execute, sandboxEnvironment, type Executor } from './process.js';
import type { AgentResult, Command, Config, Sandbox } from './types.js';

export interface SandboxOptions { name: string; repo: string; control: string; logs: string; config: Config; forceRemove?: boolean }
export class DockerSandbox implements Sandbox {
  constructor(readonly options: SandboxOptions, private readonly run: Executor = execute) {}
  private argv(...args: string[]): string[] { return [...this.options.config.sandbox.command, ...args]; }
  async create(signal: AbortSignal): Promise<void> {
    const { config, name, repo, control, logs } = this.options;
    mkdirSync(control, { recursive: true }); mkdirSync(logs, { recursive: true });
    const args = ['create', '--name', name];
    if (config.sandbox.template) args.push('--template', config.sandbox.template);
    args.push('codex', repo, `${control}:ro`);
    await checked(this.argv(...args), { signal, timeoutMs: 300000, env: sandboxEnvironment(), log: join(logs, 'sandbox-create.log') }, this.run);
    // No agent runs before the sandbox-specific GitHub network policy is in place.
    const blocked = ['github.com', 'api.github.com', 'gist.github.com', 'ssh.github.com', 'www.github.com'];
    if (config.sandbox.command[0] === 'docker') {
      await checked(this.argv('network', 'proxy', name, ...blocked.flatMap(h => ['--block-host', h])), { signal, timeoutMs: 30000, env: sandboxEnvironment() }, this.run);
    } else {
      for (const host of blocked) await checked(this.argv('policy', 'deny', 'network', '--sandbox', name, host), { signal, timeoutMs: 30000, env: sandboxEnvironment() }, this.run);
    }
    const help = await checked(this.argv('exec', name, 'codex', 'exec', '--help'), { signal, timeoutMs: 60000, env: sandboxEnvironment() }, this.run);
    if (!help.includes('--output-schema') || !help.includes('--json')) throw new Error('Sandbox Codex CLI must support --json and --output-schema');
  }
  async agent<T>(stage: string, prompt: string, schema: object, signal: AbortSignal): Promise<AgentResult<T>> {
    const { config, name, repo, control, logs } = this.options;
    const schemaPath = join(control, `${stage}.schema.json`);
    writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    writeFileSync(join(logs, `${stage}.prompt.txt`), prompt, { mode: 0o600 });
    let lastMessage = '', tokens = 0, completed = false, failed = false;
    const args = ['exec', '-i', '--workdir', repo, name, 'codex', 'exec',
      '--sandbox', 'danger-full-access', '-c', 'approval_policy="never"',
      '--json', '--color', 'never', '--output-schema', schemaPath];
    if (config.codex.model) args.push('--model', config.codex.model);
    args.push('-');
    const result = await this.run(this.argv(...args), {
      signal, input: prompt, timeoutMs: config.limits.agentMinutes * 60000,
      env: sandboxEnvironment(), log: join(logs, `${stage}.jsonl`), stderrLog: join(logs, `${stage}.stderr.log`), maxBytes: 64 * 1024 * 1024,
      onLine(line) {
        let event: { type?: string; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
        try { event = JSON.parse(line); } catch { return; }
        if (!event || typeof event !== 'object') return;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') lastMessage = event.item.text ?? '';
        if (event.type === 'turn.failed') failed = true;
        if (event.type === 'turn.completed') {
          completed = true;
          tokens += Number(event.usage?.input_tokens ?? 0) + Number(event.usage?.output_tokens ?? 0);
        }
      },
    });
    if (result.code !== 0 || failed || !completed) throw new Error(`${stage}: Codex did not complete successfully; see ${stage}.jsonl`);
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error(`${stage}: Invalid usage data`);
    try { return { value: JSON.parse(lastMessage) as T, tokens }; }
    catch { throw new Error(`${stage}: Missing or invalid structured final response`); }
  }
  async command(command: Command, log: string, signal: AbortSignal): Promise<number> {
    const cwd = commandPath(this.options.repo, command);
    const result = await this.run(this.argv('exec', '--workdir', cwd, this.options.name, ...command.argv), {
      signal, timeoutMs: this.options.config.limits.commandMinutes * 60000,
      env: sandboxEnvironment(), log, maxBytes: 64 * 1024 * 1024,
    });
    return result.code;
  }
  async remove(): Promise<void> {
    await checked(this.argv('rm', ...(this.options.forceRemove ? ['--force'] : []), this.options.name), {
      timeoutMs: 60000, env: sandboxEnvironment(),
    }, this.run);
  }
}
