import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Issue, State, Task } from './types.js';

export function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
export const taskId = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;
export class Store {
  readonly dir: string;
  state: State;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Derive Git paths, sandbox mounts, and artifacts from the same host path.
    this.dir = realpathSync(dir);
    const path = join(this.dir, 'state.json');
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as State : { version: 1, tasks: [], runs: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.tasks) || !Array.isArray(this.state.runs)) throw new Error('Unsupported state file');
    if (this.state.scouts !== undefined && !Array.isArray(this.state.scouts)) throw new Error('Invalid repository scout history');
  }
  save(): void { atomicJson(join(this.dir, 'state.json'), this.state); }
  reload(): void {
    const path = join(this.dir, 'state.json');
    if (existsSync(path)) this.state = JSON.parse(readFileSync(path, 'utf8')) as State;
  }
  enqueue(issue: Issue, score: number, skipReason?: string): boolean {
    const id = taskId(issue.repo, issue.number);
    if (this.state.tasks.some(t => t.id === id)) return false;
    this.state.tasks.push({ id, issue, score, status: skipReason ? 'skipped' : 'queued', reason: skipReason ?? '', createdAt: new Date().toISOString(), attempts: [] });
    this.save(); return true;
  }
  queued(): Task[] {
    return this.state.tasks.filter(t => t.status === 'queued').sort((a, b) => b.score - a.score
      || (Date.parse(b.issue.updatedAt) || 0) - (Date.parse(a.issue.updatedAt) || 0)
      || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  lock(): () => void {
    const path = join(this.dir, 'runner.lock');
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another command holds runner.lock. If it crashed, use recover.');
      throw error;
    }
    this.reload();
    return () => rmSync(path);
  }
}
