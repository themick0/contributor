import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, record, validRepo } from './config.js';
import type { Store } from './store.js';
import type { Config, Repository, RepositoryAssessment, RepositoryEvidence, Task } from './types.js';

export interface RepositoryCatalog {
  version: 1; criteriaHash: string; generatedAt: string; scoutId: string; repositories: Repository[];
  retainedRepositories?: Repository[];
}
export const scoutIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
export function criteriaHash(config: Config): string {
  return createHash('sha256').update(JSON.stringify({
    discovery: config.repositoryDiscovery, pinned: config.repositories,
  })).digest('hex');
}
export function readCatalog(store: Store, config: Config, log: (message: string) => void = () => {}): RepositoryCatalog | undefined {
  if (!config.repositoryDiscovery.enabled) return undefined;
  const path = join(store.dir, 'repositories.json');
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    assert(record(value) && value.version === 1, 'Unsupported repository catalog');
    if (value.criteriaHash !== criteriaHash(config)) return undefined;
    assert(typeof value.scoutId === 'string' && scoutIdPattern.test(value.scoutId), 'Invalid scout ID');
    assert(typeof value.generatedAt === 'string' && Number.isFinite(Date.parse(value.generatedAt)) && Date.parse(value.generatedAt) <= Date.now(), 'Invalid catalog date');
    assert(Array.isArray(value.repositories) && value.repositories.length <= config.repositoryDiscovery.maxRepositories, 'Invalid catalog repositories');
    assert(value.retainedRepositories === undefined || Array.isArray(value.retainedRepositories), 'Invalid retained repositories');
    const seen = new Set<string>(), excluded = new Set(config.repositoryDiscovery.excludeRepositories.map(repo => repo.toLowerCase()));
    for (const repo of [...value.repositories, ...(value.retainedRepositories as unknown[] | undefined ?? [])]) {
      assert(record(repo) && typeof repo.repo === 'string' && validRepo(repo.repo)
        && typeof repo.area === 'string' && config.repositoryDiscovery.areas.includes(repo.area)
        && Number.isInteger(repo.priority) && Number(repo.priority) >= 1 && Number(repo.priority) <= 5, 'Invalid catalog entry');
      assert(!seen.has(repo.repo.toLowerCase()) && !excluded.has(repo.repo.toLowerCase()), 'Duplicate or excluded catalog entry');
      seen.add(repo.repo.toLowerCase());
    }
    const run = store.state.scouts?.find(scout => scout.id === value.scoutId);
    assert(run?.status === 'ready' && !run.cleanupError && JSON.stringify(run.selected) === JSON.stringify(value.repositories)
      && JSON.stringify(run.retainedRepositories ?? []) === JSON.stringify(value.retainedRepositories ?? []), 'Catalog does not match a completed scout');
    return value as unknown as RepositoryCatalog;
  } catch (error) { log(`Ignoring repository catalog: ${String(error)}. Using pinned repositories.`); return undefined; }
}
export function catalogFresh(catalog: RepositoryCatalog | undefined, config: Config, now = Date.now()): boolean {
  return !!catalog && now - Date.parse(catalog.generatedAt) < config.repositoryDiscovery.refreshHours * 3600000;
}
export function withCatalog(config: Config, catalog: RepositoryCatalog | undefined, queued: Task[] = []): Config {
  if (!config.repositoryDiscovery.enabled || !catalog) return config;
  const repositories = [...config.repositories], names = new Set(repositories.map(repo => repo.repo.toLowerCase()));
  const pending = new Set(queued.filter(task => task.status === 'queued').map(task => task.issue.repo.toLowerCase()));
  const retained = (catalog.retainedRepositories ?? []).filter(repo => pending.has(repo.repo.toLowerCase()));
  for (const repo of [...catalog.repositories, ...retained]) if (!names.has(repo.repo.toLowerCase())) {
    repositories.push(repo); names.add(repo.repo.toLowerCase());
  }
  return { ...config, repositories };
}
export function retainBacklog(catalog: RepositoryCatalog | undefined, selected: Repository[], config: Config, tasks: Task[]): Repository[] {
  if (!catalog) return [];
  const pending = new Set(tasks.filter(task => ['queued', 'failed', 'interrupted', 'running'].includes(task.status)).map(task => task.issue.repo.toLowerCase()));
  const active = new Set([...config.repositories, ...selected].map(repo => repo.repo.toLowerCase()));
  return [...catalog.repositories, ...(catalog.retainedRepositories ?? [])]
    .filter(repo => pending.has(repo.repo.toLowerCase()) && !active.has(repo.repo.toLowerCase()));
}

export interface SearchPlan { queries: { area: string; query: string }[] }
export function validateSearchPlan(value: unknown, config: Config): SearchPlan {
  assert(record(value) && Array.isArray(value.queries) && value.queries.length > 0
    && value.queries.length <= config.repositoryDiscovery.maxQueries, 'Invalid repository search plan');
  const seen = new Set<string>();
  for (const item of value.queries) {
    assert(record(item) && typeof item.area === 'string' && config.repositoryDiscovery.areas.includes(item.area), 'Invalid search area');
    assert(typeof item.query === 'string' && item.query.trim().length > 0 && item.query.length <= 160
      && !/[\x00-\x1f\x7f]/.test(item.query), 'Invalid repository search query');
    const key = item.query.trim().replace(/\s+/g, ' ').toLowerCase();
    assert(!seen.has(key), 'Duplicate repository search query'); seen.add(key);
  }
  return value as unknown as SearchPlan;
}
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
export function validateAssessments(value: unknown, candidates: RepositoryEvidence[], config: Config): RepositoryAssessment[] {
  assert(record(value) && Array.isArray(value.repositories) && value.repositories.length === candidates.length, 'Scout must assess every verified candidate');
  const byName = new Map(candidates.map(candidate => [candidate.facts.repo, candidate]));
  const seen = new Set<string>(); let selected = 0;
  for (const item of value.repositories) {
    assert(record(item) && typeof item.repo === 'string' && byName.has(item.repo) && !seen.has(item.repo), 'Unknown or duplicate scout repository');
    seen.add(item.repo);
    assert(item.decision === 'select' || item.decision === 'reject', 'Invalid repository decision');
    assert(typeof item.area === 'string' && config.repositoryDiscovery.areas.includes(item.area), 'Invalid repository area');
    assert(Number.isInteger(item.priority) && Number(item.priority) >= 1 && Number(item.priority) <= 5, 'Invalid repository priority');
    assert(typeof item.reason === 'string' && item.reason.trim().length > 0 && item.reason.length <= 4000, 'Missing repository rationale');
    assert(typeof item.policy === 'string' && ['allowed', 'unspecified', 'prohibited', 'permission_required', 'unclear'].includes(item.policy), 'Invalid policy assessment');
    assert(Array.isArray(item.evidence) && item.evidence.length <= 6, 'Invalid repository evidence quotes');
    const sources = byName.get(item.repo)!.sources;
    for (const citation of item.evidence) {
      assert(record(citation) && typeof citation.source === 'string' && Object.hasOwn(sources, citation.source), 'Unknown evidence source');
      assert(typeof citation.quote === 'string' && normalized(citation.quote).length >= 12 && citation.quote.length <= 1200
        && normalized(sources[citation.source]!).includes(normalized(citation.quote)), 'Unsupported evidence quote');
    }
    if (item.decision === 'select') {
      selected++;
      assert(item.policy === 'allowed' || item.policy === 'unspecified', 'Repository policy prevents automatic selection');
      assert(item.evidence.some(citation => ['README', 'package.json'].includes(citation.source))
        && item.evidence.some(citation => citation.source === 'open_issues'), 'Selection needs library and issue evidence');
      if (item.policy === 'allowed') assert(item.evidence.some(citation => /CONTRIBUTING|AGENTS|README/.test(citation.source)), 'Explicit permission needs a policy source');
    }
  }
  assert(selected <= config.repositoryDiscovery.maxRepositories, 'Too many selected repositories');
  return value.repositories as RepositoryAssessment[];
}
