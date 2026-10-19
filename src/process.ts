import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';

export interface ProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number;
  signal?: AbortSignal; log?: string; stderrLog?: string; onLine?: (line: string) => void;
  maxBytes?: number;
}
export interface ProcessResult { code: number; stdout: string; stderr: string }
export type Executor = (argv: string[], options?: ProcessOptions) => Promise<ProcessResult>;

export const execute: Executor = async (argv, options = {}) => {
  if (!argv[0]) throw new Error('Empty command');
  options.signal?.throwIfAborted();
  const fd = options.log ? openSync(options.log, 'w', 0o600) : undefined;
  const errFd = options.stderrLog ? openSync(options.stderrLog, 'w', 0o600) : undefined;
  return await new Promise<ProcessResult>((resolve, reject) => {
    let stdout = '', stderr = '', pending = '', bytes = 0;
    let failure: Error | undefined;
    let force: NodeJS.Timeout | undefined;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd, env: options.env ?? process.env,
      shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
    };
    const stop = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const abort = () => stop('Process cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => stop(`Process timeout after ${options.timeoutMs ?? 60000}ms`), options.timeoutMs ?? 60000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const consume = (chunk: string, output: boolean) => {
      try {
        bytes += Buffer.byteLength(chunk);
        if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) { stop('Process output exceeded limit'); return; }
        const target = output ? fd : errFd ?? fd;
        if (target !== undefined) writeSync(target, chunk);
        if (output) {
          stdout = options.onLine ? (stdout + chunk).slice(-65536) : stdout + chunk;
          if (options.onLine) {
            pending += chunk;
            const lines = pending.split('\n'); pending = lines.pop()!;
            for (const line of lines) options.onLine(line);
          }
        } else stderr = (stderr + chunk).slice(-65536);
      } catch (error) { stop(`Cannot record process output: ${String(error)}`); }
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error.message); });
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      clearTimeout(timeout);
      if (force) {
        clearTimeout(force);
        // The parent can close its streams while SIGTERM-ignoring descendants survive.
        kill('SIGKILL');
      }
      options.signal?.removeEventListener('abort', abort);
      if (fd !== undefined) closeSync(fd);
      if (errFd !== undefined) closeSync(errFd);
      try { if (pending && options.onLine) options.onLine(pending); } catch (error) { failure ??= new Error(String(error)); }
      if (failure) reject(failure); else resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
    if (options.signal?.aborted) abort();
  });
};

export function sandboxEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|SSH_AUTH_SOCK|GIT_CONFIG|NODE_OPTIONS|BASH_ENV|ENV$/i.test(key)) delete env[key];
  }
  return env;
}
export async function checked(argv: string[], options: ProcessOptions = {}, run: Executor = execute): Promise<string> {
  const result = await run(argv, options);
  if (result.code !== 0) throw new Error(`${argv[0]} exited ${result.code}: ${(result.stderr || result.stdout).slice(-2000)}`);
  return result.stdout.trim();
}
