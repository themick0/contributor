import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { execute, type Executor, type ProcessResult } from './process.js';
import { atomicJson } from './store.js';

export interface GitHubApiOptions {
  cooldownPath?: string;
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
interface Response { status: number | undefined; headers: Map<string, string>; body: string }
interface ApiResponse<T> { data: T; headers: Map<string, string> }

function parseResponse(output: string): Response {
  const status = /^HTTP\/\S+\s+(\d{3})\b/.exec(output);
  const separator = /\r?\n\r?\n/.exec(output);
  if (!status || !separator) return { status: undefined, headers: new Map(), body: output };
  const headers = new Map<string, string>();
  for (const line of output.slice(0, separator.index).split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers, body: output.slice(separator.index + separator[0].length) };
}

function serverDelay(headers: Map<string, string>, now: number): number | undefined {
  const waits: number[] = [];
  const serverDate = Date.parse(headers.get('date') ?? '');
  const reference = Number.isFinite(serverDate) ? serverDate : now;
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== undefined) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - reference;
    if (Number.isFinite(wait)) waits.push(Math.max(1000, wait));
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) waits.push(Math.max(1000, reset * 1000 - reference + 1000));
  }
  return waits.length ? Math.max(...waits) : undefined;
}

const transient = /Process timeout|connection reset|connection refused|TLS handshake timeout|i\/o timeout|temporary failure|unexpected EOF|network is unreachable|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i;
const maxRetries = 5;

export class GitHubApi {
  private queue: Promise<void> = Promise.resolve();
  private nextRequest = 0;
  private nextSearch = 0;
  private cooldown = 0;
  private stopped: Error | undefined;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(private readonly run: Executor = execute, private readonly signal?: AbortSignal, private readonly options: GitHubApiOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, signal ? { signal } : {}); });
    this.log = options.log ?? (message => console.error(message));
  }

  get stopReason(): string | undefined { return this.stopped?.message; }

  request<T>(endpoint: string, args: string[] = [], taskSignal?: AbortSignal): Promise<ApiResponse<T>> {
    const signal = taskSignal && this.signal ? AbortSignal.any([taskSignal, this.signal]) : taskSignal ?? this.signal;
    const pending = this.queue.then(() => this.send<T>(endpoint, args, signal));
    this.queue = pending.then(() => {}, () => {});
    if (!signal) return pending;
    // A cancelled caller need not wait for another task's rate-limit pause.
    // Its queued operation still checks the signal before issuing any request.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }

  private readCooldown(): void {
    const path = this.options.cooldownPath;
    if (!path || !existsSync(path)) return;
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!stored || typeof stored !== 'object' || !('until' in stored) || typeof stored.until !== 'number' || !Number.isFinite(stored.until) || stored.until < 0) {
      throw new Error(`Invalid GitHub cooldown state: ${path}`);
    }
    this.cooldown = Math.max(this.cooldown, stored.until);
  }

  private saveCooldown(until: number): void {
    this.readCooldown();
    this.cooldown = Math.max(this.cooldown, until);
    if (this.options.cooldownPath) atomicJson(this.options.cooldownPath, { until: this.cooldown });
  }

  private async waitUntil(until: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    while (this.now() < until) {
      await this.sleep(Math.min(60000, until - this.now()), signal);
      signal?.throwIfAborted();
    }
  }

  private async send<T>(endpoint: string, args: string[], signal?: AbortSignal): Promise<ApiResponse<T>> {
    let previousWait = 0;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      if (this.stopped) throw this.stopped;
      this.readCooldown();
      if (this.cooldown > this.now()) this.log(`GitHub cooldown: waiting until ${new Date(this.cooldown).toISOString()} before GET ${endpoint}.`);
      const search = endpoint.startsWith('search/');
      await this.waitUntil(Math.max(this.cooldown, this.nextRequest, search ? this.nextSearch : 0), signal);
      this.nextRequest = this.now() + 1000;
      if (search) this.nextSearch = this.now() + 3000;
      let result: ProcessResult;
      try {
        result = await this.run(['gh', 'api', '--method', 'GET', endpoint, '--include', ...args], { timeoutMs: 45000, ...(signal ? { signal } : {}) });
      } catch (error) {
        signal?.throwIfAborted();
        if (!transient.test(String(error))) throw error;
        result = { code: 1, stdout: '', stderr: String(error) };
      }
      signal?.throwIfAborted();
      const response = parseResponse(result.stdout);
      const status = response.status ?? Number(/\bHTTP (\d{3})\b/.exec(result.stderr)?.[1]);
      if (result.code === 0 && (!status || status < 400)) {
        if (response.headers.get('x-ratelimit-remaining') === '0') this.saveCooldown(this.now() + (serverDelay(response.headers, this.now()) ?? 60000));
        return { data: JSON.parse(response.body) as T, headers: response.headers };
      }
      const detail = (result.stderr.trim() || response.body.trim() || `gh exited ${result.code}`).slice(-2000);
      const rateLimited = status === 429 || (status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0' || /rate limit|abuse detection/i.test(response.body + result.stderr)));
      const retryable = rateLimited || status >= 500 && status <= 599 || (!status && transient.test(detail));
      if (!retryable) throw new Error(`GitHub GET ${endpoint} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
      const wait = Math.max(previousWait * 2, rateLimited ? serverDelay(response.headers, this.now()) ?? 60000 : 5000);
      previousWait = wait;
      const until = this.now() + wait;
      if (rateLimited) this.saveCooldown(until);
      if (attempt >= maxRetries) {
        const error = new Error(`GitHub ${rateLimited ? 'rate limit' : 'request failure'} after ${maxRetries} retries for GET ${endpoint}. ${rateLimited ? `Requests paused until ${new Date(this.cooldown).toISOString()}. ` : ''}${detail}`);
        if (rateLimited) this.stopped = error;
        throw error;
      }
      this.log(`GitHub ${rateLimited ? 'rate limit' : 'temporary failure'} on GET ${endpoint}; waiting ${Math.ceil(wait / 1000)}s before retry ${attempt + 1}/${maxRetries}.`);
      await this.waitUntil(until, signal);
    }
  }
}
