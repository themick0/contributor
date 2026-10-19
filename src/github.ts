import { checked, type Executor, type ProcessOptions, execute } from './process.js';
import { validRepo } from './config.js';
import type { Config, GitHub, Issue, IssueContext, Repository } from './types.js';

interface ApiIssue {
  number: number; title: string; body: string | null; html_url: string; state: string;
  labels: { name: string }[]; assignees: { login: string }[]; updated_at: string;
  pull_request?: unknown;
}
export function normalize(repo: string, raw: ApiIssue): Issue {
  if (raw.pull_request || !Number.isInteger(raw.number) || raw.number <= 0) throw new Error('Expected a GitHub issue');
  return { repo, number: raw.number, title: raw.title, body: raw.body ?? '', url: raw.html_url,
    state: raw.state, labels: raw.labels.map(l => l.name), assignees: raw.assignees.map(a => a.login), updatedAt: raw.updated_at };
}
export function parseIssueUrl(url: string): { repo: string; number: number } {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/.exec(url);
  if (!m || !validRepo(m[1]!) || !Number.isSafeInteger(Number(m[2]))) throw new Error('Expected https://github.com/owner/repo/issues/123');
  return { repo: m[1]!, number: Number(m[2]) };
}
export function eligible(issue: Issue, config: Config): string | undefined {
  if (issue.state.toLowerCase() !== 'open') return 'Issue is closed';
  if (issue.assignees.length) return 'Issue is assigned';
  const labels = issue.labels.map(l => l.toLowerCase());
  if (config.discovery.excludeLabels.some(l => labels.includes(l.toLowerCase()))) return 'Excluded label';
  return undefined;
}
export function scoreIssue(issue: Issue, repo: Repository, config: Config): number {
  if (eligible(issue, config)) return 0;
  const labels = issue.labels.map(l => l.toLowerCase());
  let score = repo.priority * 4;
  if (labels.includes('bug')) score += 20;
  if (labels.includes('good first issue')) score += 20;
  if (labels.includes('help wanted')) score += 15;
  if (config.discovery.includeLabels.some(l => labels.includes(l.toLowerCase()))) score += 10;
  if (/reproduc|stackblitz|codesandbox|expected|actual/i.test(issue.body)) score += 10;
  if (/breaking|rewrite|redesign|rfc|proposal/i.test(issue.title)) score -= 35;
  return score;
}
export class GitHubClient implements GitHub {
  constructor(private readonly run: Executor = execute, private readonly signal?: AbortSignal) {}
  private async api<T>(endpoint: string, args: string[] = []): Promise<T> {
    const options: ProcessOptions = { timeoutMs: 45000 };
    if (this.signal) options.signal = this.signal;
    return JSON.parse(await checked(['gh', 'api', '--method', 'GET', endpoint, ...args], options, this.run)) as T;
  }
  async search(repo: string, limit: number): Promise<Issue[]> {
    const meta = await this.api<{ archived: boolean; disabled: boolean }>(`repos/${repo}`);
    if (meta.archived || meta.disabled) return [];
    const data = await this.api<{ items: ApiIssue[] }>('search/issues', ['-f', `q=repo:${repo} is:issue is:open no:assignee`, '-f', 'sort=updated', '-f', 'order=desc', '-f', `per_page=${limit}`]);
    return data.items.map(i => normalize(repo, i));
  }
  async context(repo: string, number: number): Promise<IssueContext> {
    const base = `repos/${repo}/issues/${number}`;
    const [raw, timeline, comments] = await Promise.all([
      this.api<ApiIssue>(base),
      this.api<Array<Array<{ event: string; source?: { issue?: ApiIssue } }>>>(`${base}/timeline?per_page=100`, ['--paginate', '--slurp']),
      this.api<Array<Array<{ user?: { login: string }; body: string }>>>(`${base}/comments?per_page=100`, ['--paginate', '--slurp']),
    ]);
    return {
      issue: normalize(repo, raw),
      openPullRequests: timeline.flat().filter(e => e.source?.issue?.pull_request && e.source.issue.state === 'open').map(e => e.source!.issue!.html_url),
      comments: comments.flat().slice(-25).map(c => `${c.user?.login ?? 'unknown'}: ${c.body}`).map(c => c.slice(0,12000)),
    };
  }
}
