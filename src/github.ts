import { type Executor, execute } from './process.js';
import { validRepo } from './config.js';
import { GitHubApi, type GitHubApiOptions } from './github-api.js';
import type { Config, GitHub, Issue, IssueContext, Repository, RepositoryEvidence, RepositoryFacts, RepositoryResearch } from './types.js';

interface ApiIssue {
  number: number; title: string; body: string | null; html_url: string; state: string;
  labels: { name: string }[]; assignees: { login: string }[]; updated_at: string;
  pull_request?: unknown;
}
interface ApiRepository {
  full_name: string; description: string | null; stargazers_count: number; pushed_at: string;
  archived: boolean; disabled: boolean; fork: boolean; private: boolean;
  language: string | null; license: { spdx_id: string } | null; topics?: string[];
}
function repository(raw: ApiRepository): RepositoryFacts {
  if (!validRepo(raw.full_name) || !Number.isSafeInteger(raw.stargazers_count) || raw.stargazers_count < 0
    || !Number.isFinite(Date.parse(raw.pushed_at)) || [raw.archived, raw.disabled, raw.fork, raw.private].some(value => typeof value !== 'boolean')) throw new Error('Invalid GitHub repository metadata');
  return { repo: raw.full_name, description: raw.description ?? '', stars: raw.stargazers_count,
    pushedAt: raw.pushed_at, archived: raw.archived, disabled: raw.disabled, fork: raw.fork, private: raw.private,
    language: raw.language, license: raw.license?.spdx_id ?? null, topics: raw.topics ?? [] };
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
export function scoreIssue(issue: Issue, repo: Repository, config: Config, now = Date.now()): number {
  if (eligible(issue, config)) return 0;
  const labels = issue.labels.map(l => l.toLowerCase());
  let score = repo.priority * 4;
  if (labels.includes('bug')) score += 20;
  if (labels.includes('good first issue')) score += 20;
  if (labels.includes('help wanted')) score += 15;
  if (config.discovery.includeLabels.some(l => labels.includes(l.toLowerCase()))) score += 10;
  // Template headings alone are not reproduction evidence.
  const reproductionLink = /https?:\/\/(?:[\w-]+\.)?(?:stackblitz\.com|codesandbox\.io|tsplay\.dev|typescriptlang\.org\/play|gist\.github\.com)(?=[/?#]|$)/i.test(issue.body);
  const codeExample = [...issue.body.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)].some(match => match[1]!.trim().length >= 30 && /\b(?:import|require|const|let|function|await|assert|fetch)\b|=>/.test(match[1]!));
  if (reproductionLink) score += 15;
  if (codeExample) score += 10;
  if (!reproductionLink && !codeExample) score -= 10;
  const ageDays = (now - Date.parse(issue.updatedAt)) / 86400000;
  if (Number.isFinite(ageDays)) {
    if (ageDays <= 90) score += 10;
    else if (ageDays <= 180) score += 5;
    else if (ageDays > 730) score -= 20;
    else if (ageDays > 365) score -= 10;
  }
  if (!labels.includes('bug') && labels.some(label => ['enhancement', 'feature request', 'rfc', 'proposal'].includes(label))) score -= 20;
  if (/breaking|rewrite|redesign|rfc|proposal/i.test(issue.title)) score -= 35;
  return score;
}
export class GitHubClient implements GitHub, RepositoryResearch {
  private readonly api: GitHubApi;
  private readonly availableRepositories = new Map<string, boolean>();
  constructor(run: Executor = execute, signal?: AbortSignal, options: GitHubApiOptions = {}) {
    this.api = new GitHubApi(run, signal, options);
  }
  get stopReason(): string | undefined { return this.api.stopReason; }
  async login(): Promise<string> {
    const { data } = await this.api.request<{ login: string }>('user');
    if (typeof data.login !== 'string' || !data.login.trim()) throw new Error('GitHub returned no authenticated login');
    return data.login;
  }
  private async pages<T>(endpoint: string, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [], seen = new Set<string>();
    let next: string | undefined = endpoint;
    while (next) {
      if (seen.has(next)) throw new Error('GitHub returned a pagination loop');
      seen.add(next);
      const response: { data: T[]; headers: Map<string, string> } = await this.api.request<T[]>(next, [], signal);
      if (!Array.isArray(response.data)) throw new Error(`Expected a GitHub result array: ${next}`);
      items.push(...response.data);
      const link: string | undefined = response.headers.get('link')?.split(/,\s*(?=<)/).find(part => /;\s*rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1];
      next = undefined;
      if (link) {
        const url: URL = new URL(link);
        if (url.origin !== 'https://api.github.com' || url.username || url.password) throw new Error('Unexpected GitHub pagination host');
        next = url.pathname.slice(1) + url.search;
      }
    }
    return items;
  }
  async search(repo: string, limit: number, page = 1, signal?: AbortSignal): Promise<Issue[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(page) || page < 1 || limit * page > 1000) throw new Error('Invalid GitHub search page or page size');
    const key = repo.toLowerCase();
    if (!this.availableRepositories.has(key)) {
      const { data: meta } = await this.api.request<{ archived: boolean; disabled: boolean }>(`repos/${repo}`, [], signal);
      this.availableRepositories.set(key, !meta.archived && !meta.disabled);
    }
    if (!this.availableRepositories.get(key)) return [];
    const { data } = await this.api.request<{ items: ApiIssue[] }>('search/issues', ['-f', `q=repo:${repo} is:issue is:open no:assignee`, '-f', 'sort=updated', '-f', 'order=desc', '-f', `per_page=${limit}`, '-f', `page=${page}`], signal);
    return data.items.map(i => normalize(repo, i));
  }
  async context(repo: string, number: number, signal?: AbortSignal): Promise<IssueContext> {
    const base = `repos/${repo}/issues/${number}`;
    const { data: raw } = await this.api.request<ApiIssue>(base, [], signal);
    const timeline = await this.pages<{ event: string; source?: { issue?: ApiIssue } }>(`${base}/timeline?per_page=100`, signal);
    const comments = await this.pages<{ user?: { login: string }; body: string }>(`${base}/comments?per_page=100`, signal);
    return {
      issue: normalize(repo, raw),
      openPullRequests: timeline.filter(e => e.source?.issue?.pull_request && e.source.issue.state === 'open').map(e => e.source!.issue!.html_url),
      comments: comments.slice(-25).map(c => `${c.user?.login ?? 'unknown'}: ${c.body}`).map(c => c.slice(0,12000)),
    };
  }
  async searchRepositories(query: string, limit: number, signal?: AbortSignal): Promise<RepositoryFacts[]> {
    if (!query.trim() || query.length > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid repository search');
    const { data } = await this.api.request<{ items: ApiRepository[] }>('search/repositories', ['-f', `q=${query}`, '-f', 'sort=stars', '-f', 'order=desc', '-f', `per_page=${limit}`], signal);
    return data.items.map(repository);
  }
  async repositoryFacts(repo: string, signal?: AbortSignal): Promise<RepositoryFacts> {
    if (!validRepo(repo)) throw new Error('Invalid repository name');
    const { data } = await this.api.request<ApiRepository>(`repos/${repo}`, [], signal);
    const facts = repository(data);
    this.availableRepositories.set(facts.repo.toLowerCase(), !facts.archived && !facts.disabled);
    return facts;
  }
  private async repositoryText(repo: string, path: string, limit: number, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { data } = await this.api.request<{ type?: string; encoding: string; content: string }>(`repos/${repo}/${path}`, [], signal);
      if (data.type === 'symlink' || data.type === 'submodule' || data.encoding !== 'base64' || typeof data.content !== 'string') return undefined;
      const decoded = Buffer.from(data.content, 'base64').toString('utf8');
      return decoded.slice(0, limit) + (decoded.length > limit ? '\n[Source excerpt truncated by controller.]' : '');
    } catch (error) {
      if (/\(HTTP 404\)/.test(String(error))) return undefined;
      throw error;
    }
  }
  async repositoryEvidence(facts: RepositoryFacts, config: Config, signal?: AbortSignal): Promise<RepositoryEvidence> {
    const repo = facts.repo;
    const { data: languageBytes } = await this.api.request<Record<string, number>>(`repos/${repo}/languages`, [], signal);
    const languages = Object.keys(languageBytes).filter(name => Number.isFinite(languageBytes[name]) && languageBytes[name]! > 0);
    const sources: Record<string, string> = { metadata: JSON.stringify(facts, null, 2), languages: JSON.stringify(languageBytes) };
    if (!languages.some(language => ['TypeScript', 'JavaScript'].includes(language))) return { facts, languages, issues: [], sources };
    for (const [name, path, limit] of [
      ['README', 'readme', 6000], ['CONTRIBUTING.md', 'contents/CONTRIBUTING.md', 6000],
      ['.github/CONTRIBUTING.md', 'contents/.github/CONTRIBUTING.md', 6000],
      ['AGENTS.md', 'contents/AGENTS.md', 4000], ['package.json', 'contents/package.json', 3000],
    ] as const) {
      const body = await this.repositoryText(repo, path, limit, signal);
      if (body !== undefined) sources[name] = body;
    }
    const options = config.repositoryDiscovery, candidates: Issue[] = [], seen = new Set<number>();
    const ranking = { repo, area: 'typescript', priority: 3 };
    let pages = 0, inspected = 0;
    for (let page = 1; page <= options.maxIssuePages; page++) {
      const batch = await this.search(repo, options.issuesPerPage, page, signal);
      pages++; inspected += batch.length;
      for (const issue of batch) if (!seen.has(issue.number)) {
        seen.add(issue.number);
        if (!eligible(issue, config)) candidates.push(issue);
      }
      if (batch.length < options.issuesPerPage || candidates.filter(issue => scoreIssue(issue, ranking, config) >= config.discovery.minScore).length >= options.issueSamples) break;
    }
    const issues = candidates.sort((a, b) => scoreIssue(b, ranking, config) - scoreIssue(a, ranking, config)
      || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, options.issueSamples).map(issue => ({ ...issue, body: issue.body.slice(0, 1500) }));
    sources.issue_sampling = JSON.stringify({ pages, inspected, eligible: candidates.length, sampleSize: issues.length, maxPages: options.maxIssuePages, pageSize: options.issuesPerPage });
    sources.open_issues = JSON.stringify(issues, null, 2);
    const { data: pulls } = await this.api.request<Array<{ title: string; html_url: string; merged_at: string | null; updated_at: string; author_association: string }>>(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=5`, [], signal);
    sources.recent_pull_requests = JSON.stringify(pulls.map(pull => ({ title: pull.title, url: pull.html_url, mergedAt: pull.merged_at, updatedAt: pull.updated_at, authorAssociation: pull.author_association })), null, 2);
    return { facts, languages, issues, sources };
  }
}
