import { eligible, scoreIssue } from './github.js';
import { Store, taskId } from './store.js';
import type { Config, GitHub, Issue, IssueContext, Repository } from './types.js';

interface Candidate { issue: Issue; score: number }
interface Pool { repository: Repository; candidates: Candidate[]; page: number; exhausted: boolean; checks: number }
export interface DiscoverySession { pools: Map<string, Pool>; seen: Set<string> }
export const createDiscoverySession = (): DiscoverySession => ({ pools: new Map(), seen: new Set() });
export function discoveryHasMore(session: DiscoverySession, repositories: Repository[]): boolean {
  return repositories.some(repository => {
    const pool = session.pools.get(repository.repo.toLowerCase());
    return !pool || pool.candidates.length > 0 || !pool.exhausted;
  });
}
interface DiscoveryOptions { session?: DiscoverySession; repositories?: Repository[]; signal?: AbortSignal }

function fatal(error: unknown, github: GitHub): boolean {
  return Boolean(github.stopReason) || /Bad credentials|HTTP 401|rate limit|HTTP 429|cancelled/i.test(String(error))
    || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
}
const compare = (a: Candidate, b: Candidate) => b.score - a.score
  || (Date.parse(b.issue.updatedAt) || 0) - (Date.parse(a.issue.updatedAt) || 0)
  || a.issue.number - b.issue.number;

export async function discover(store: Store, config: Config, github: GitHub, log: (message: string) => void, options: DiscoveryOptions = {}): Promise<number> {
  options.signal?.throwIfAborted();
  const repositories = options.repositories ?? config.repositories;
  if (!repositories.length) return 0;
  const activeRepos = new Set(config.repositories.map(repo => repo.repo.toLowerCase()));
  const queuedPerRepo = new Map<string, number>();
  for (const task of store.queued()) {
    const repo = task.issue.repo.toLowerCase();
    if (activeRepos.has(repo)) queuedPerRepo.set(repo, (queuedPerRepo.get(repo) ?? 0) + 1);
  }
  let queued = [...queuedPerRepo.values()].reduce((sum, count) => sum + count, 0);
  if (queued >= config.discovery.maxQueued) { log('Discovery skipped: the configured repositories already fill the queue.'); return 0; }

  const history = new Map(store.state.tasks.map(task => [task.id, task]));
  const session = options.session ?? createDiscoverySession(), seen = session.seen;
  const pools = repositories.map(repository => {
    const key = repository.repo.toLowerCase();
    let pool = session.pools.get(key);
    if (!pool) { pool = { repository, candidates: [], page: 0, exhausted: false, checks: 0 }; session.pools.set(key, pool); }
    pool.checks = 0; return pool;
  });
  const firstPages = new Map(pools.map(pool => [pool, pool.page]));
  const canLoad = (pool: Pool) => !pool.exhausted && pool.page - firstPages.get(pool)! < config.discovery.maxPagesPerRepo;
  const available = (pool: Pool) => pool.candidates.length > 0 || canLoad(pool);
  let count = 0, checked = 0, skipped = 0, successfulPages = 0, requestedPages = 0;
  const hasCapacity = () => queued < config.discovery.maxQueued && checked < config.discovery.maxCandidateChecks;

  const load = async (pool: Pool) => {
    while (!pool.candidates.length && canLoad(pool)) {
      options.signal?.throwIfAborted();
      const page = pool.page + 1, repo = pool.repository.repo;
      let issues: Issue[];
      requestedPages++;
      try { issues = await github.search(repo, config.discovery.issuesPerRepo, page, options.signal); }
      catch (error) {
        if (fatal(error, github)) throw error;
        log(`${repo}: ${String(error)}`); pool.exhausted = true; return;
      }
      successfulPages++; pool.page = page;
      pool.exhausted = issues.length < config.discovery.issuesPerRepo || (page + 1) * config.discovery.issuesPerRepo > 1000;
      log(`${repo}: ${issues.length} issues inspected (page ${page})`);
      let refreshed = false;
      for (const issue of issues) {
        const id = taskId(issue.repo, issue.number), score = scoreIssue(issue, pool.repository, config);
        const existing = history.get(id);
        if (existing) {
          if (existing.status === 'queued') { existing.issue = issue; existing.score = score; refreshed = true; }
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        if (score >= config.discovery.minScore) pool.candidates.push({ issue, score });
      }
      if (refreshed) store.save();
      pool.candidates.sort(compare);
    }
  };

  const screen = async (pool: Pool): Promise<void> => {
    await load(pool);
    const candidate = pool.candidates.shift();
    if (!candidate) return;
    const repo = pool.repository.repo, id = taskId(repo, candidate.issue.number);
    if (history.has(id)) return;
    options.signal?.throwIfAborted();
    checked++; pool.checks++;
    let context: IssueContext;
    try { context = await github.context(repo, candidate.issue.number, options.signal); }
    catch (error) {
      if (fatal(error, github)) throw error;
      log(`${id}: candidate check failed: ${String(error)}`); return;
    }
    const reason = eligible(context.issue, config)
      ?? (context.openPullRequests.length ? `Already referenced by open PR: ${context.openPullRequests.join(', ')}` : undefined);
    const score = scoreIssue(context.issue, pool.repository, config);
    if (reason) {
      // Remember definitive rejections so subsequent scans can get past them.
      if (store.enqueue(context.issue, score, reason)) skipped++;
      log(`${id}: discovery skipped — ${reason}`);
    } else if (score >= config.discovery.minScore && store.enqueue(context.issue, score)) {
      count++; queued++;
      const key = repo.toLowerCase();
      queuedPerRepo.set(key, (queuedPerRepo.get(key) ?? 0) + 1);
    }
  };

  // Give each repository an initial opportunity before filling remaining slots.
  // Repositories with many linked PRs cannot spend the entire screening budget.
  const targetPerRepo = Math.max(1, Math.floor(config.discovery.maxQueued / pools.length));
  const checksPerRepo = Math.max(1, Math.floor(config.discovery.maxCandidateChecks / pools.length));
  for (const pool of pools) {
    if (!hasCapacity()) break;
    await load(pool);
    while (hasCapacity() && available(pool)
      && (queuedPerRepo.get(pool.repository.repo.toLowerCase()) ?? 0) < targetPerRepo && pool.checks < checksPerRepo) {
      await screen(pool);
    }
  }
  while (hasCapacity()) {
    const remaining = pools.filter(available);
    if (!remaining.length) break;
    remaining.sort((a, b) => (queuedPerRepo.get(a.repository.repo.toLowerCase()) ?? 0) - (queuedPerRepo.get(b.repository.repo.toLowerCase()) ?? 0)
      || a.checks - b.checks || b.repository.priority - a.repository.priority);
    await screen(remaining[0]!);
  }
  if (requestedPages && !successfulPages && !checked) throw new Error('Discovery failed for every repository; check gh authentication/rate limit');
  log(`Discovery: ${count} queued, ${skipped} skipped, ${checked}/${config.discovery.maxCandidateChecks} candidate checks.`);
  return count;
}
