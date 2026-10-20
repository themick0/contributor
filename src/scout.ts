import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eligible } from './github.js';
import { checked } from './process.js';
import { catalogFresh, criteriaHash, readCatalog, retainBacklog, validateAssessments, validateSearchPlan } from './repositories.js';
import { DockerSandbox } from './sandbox.js';
import { scoutPlanSchema, scoutSelectionSchema } from './schemas.js';
import { atomicJson, Store } from './store.js';
import type { Config, RepositoryEvidence, RepositoryFacts, RepositoryResearch, Sandbox, ScoutRun } from './types.js';

export interface ScoutDependencies {
  github: RepositoryResearch;
  sandbox?: (scout: ScoutRun, repo: string, control: string, logs: string) => Sandbox;
  log?: (message: string) => void;
}
export interface ScoutResult { tokens: number; cached: boolean; scout: ScoutRun | undefined }
const escape = (text: string) => text.replace(/[\r\n|]/g, ' ').replace(/</g, '&lt;');
export function writeScoutReport(scout: ScoutRun): void {
  mkdirSync(scout.dir, { recursive: true });
  const rows = scout.assessments.map(item => `| [${item.repo}](https://github.com/${item.repo}) | ${item.decision} | ${item.area} | ${item.priority} | ${item.policy} | ${escape(item.reason)} |`);
  writeFileSync(join(scout.dir, 'report.md'), `# Repository scout ${scout.id}\n\nStatus: ${scout.status}. ${scout.selected.length} selected. Reported tokens: ${scout.tokens}.\n\nStarted: ${scout.startedAt}. Finished: ${scout.finishedAt ?? 'running'}.\n\n${escape(scout.reason)}\n\n| Repository | Decision | Area | Priority | Policy | Reason |\n| --- | --- | --- | ---: | --- | --- |\n${rows.join('\n')}\n\n## Evidence\n\nRead [result.json](result.json) for validated assessments and quotes, [screening.json](screening.json) for host checks, [searches.json](searches.json) for search results, and [control/evidence.json](control/evidence.json) for source excerpts. Raw model output and prompts are retained in logs/.\n\nSearches and evidence samples are bounded, not exhaustive. A selection identifies a candidate library, not an approved or confirmed available task. Issue discovery and the task planner recheck current issue activity and contribution policy. No upstream writes are performed.\n`);
}
function exclusion(facts: RepositoryFacts, config: Config, excluded: Set<string>, now: number): string | undefined {
  if (excluded.has(facts.repo.toLowerCase())) return 'Pinned, excluded, or already inspected';
  if (facts.private || facts.archived || facts.disabled || facts.fork) return 'Repository must be public, active, and not a fork';
  if (facts.stars < config.repositoryDiscovery.minStars) return 'Below the star threshold';
  if (!Number.isFinite(Date.parse(facts.pushedAt)) || now - Date.parse(facts.pushedAt) > config.repositoryDiscovery.maxInactiveDays * 86400000) return 'No recent push within the activity threshold';
  return undefined;
}

/** Caller holds runner.lock. Catalog publication follows validation and successful cleanup. */
export async function scoutRepositories(store: Store, config: Config, root: string, deps: ScoutDependencies, signal: AbortSignal, force = false): Promise<ScoutResult> {
  const log = deps.log ?? (() => {}), options = config.repositoryDiscovery;
  if (!options.enabled) return { tokens: 0, cached: false, scout: undefined };
  if (store.state.scouts?.some(scout => scout.status === 'running' || scout.cleanupError)) throw new Error('An unfinished repository scout needs recover before another run');
  const catalog = readCatalog(store, config, log);
  if (!force && catalogFresh(catalog, config)) {
    log(`Repository scout: using ${catalog!.repositories.length} cached targets (refresh every ${options.refreshHours}h).`);
    return { tokens: 0, cached: true, scout: store.state.scouts?.find(scout => scout.id === catalog!.scoutId) };
  }
  signal.throwIfAborted();
  if (deps.github.stopReason) throw new Error(deps.github.stopReason);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}`;
  const dir = join(store.dir, 'scouts', id), repo = join(dir, 'repo'), control = join(dir, 'control'), logs = join(dir, 'logs');
  const scout: ScoutRun = { id, dir, sandbox: `contrib-${randomUUID().slice(0,8)}-0`, startedAt: new Date().toISOString(), status: 'running', reason: '', tokens: 0, selected: [], assessments: [] };
  mkdirSync(control, { recursive: true }); mkdirSync(logs, { recursive: true }); mkdirSync(repo);
  (store.state.scouts ??= []).push(scout); store.save();
  const scoutSignal = AbortSignal.any([signal, AbortSignal.timeout(options.minutes * 60000)]);
  const budget = () => {
    scoutSignal.throwIfAborted();
    if (scout.tokens >= Math.min(options.softTokenBudget, config.limits.softTokenBudget)) throw new Error('Repository scout soft token budget reached');
    if (deps.github.stopReason) throw new Error(deps.github.stopReason);
  };
  let sandbox: Sandbox | undefined, created = false;
  const screening: { repo: string; reason: string }[] = [];
  const searches: { area: string; query: string; repositories?: RepositoryFacts[]; error?: string }[] = [];
  const evidence: RepositoryEvidence[] = [];
  const persist = () => { atomicJson(join(dir, 'result.json'), scout); writeScoutReport(scout); store.save(); };
  try {
    budget();
    await checked(['git', 'init', '--quiet', repo], { signal: scoutSignal });
    sandbox = deps.sandbox?.(scout, repo, control, logs) ?? new DockerSandbox({ name: scout.sandbox, repo, control, logs, config, forceRemove: config.sandbox.command[0] === 'sbx' });
    created = true;
    await sandbox.create(scoutSignal);
    const agent = async (stage: string, schema: object, context: unknown): Promise<unknown> => {
      budget(); log(`Repository scout: ${stage}`);
      const prompt = `${readFileSync(join(root, 'prompts', `${stage}.md`), 'utf8')}\n\nController context:\n${JSON.stringify(context, null, 2)}`;
      const result = await sandbox!.agent<unknown>(stage, prompt, schema, scoutSignal);
      if (!Number.isFinite(result.tokens) || result.tokens < 0) throw new Error('Invalid scout token usage');
      scout.tokens += result.tokens; store.save();
      atomicJson(join(dir, `${stage}.json`), result.value);
      return result.value;
    };
    const plan = validateSearchPlan(await agent('scout-plan', scoutPlanSchema, {
      ...options, pinnedRepositories: config.repositories,
    }), config);
    const now = Date.now(), cutoff = new Date(now - options.maxInactiveDays * 86400000).toISOString().slice(0, 10);
    const pools: RepositoryFacts[][] = [];
    let failures = 0;
    for (const item of plan.queries) {
      budget();
      const query = `${item.query.trim()} fork:false archived:false stars:>=${options.minStars} pushed:>=${cutoff}`;
      if (query.length > 256) throw new Error('Repository query exceeds GitHub search length');
      try {
        const repositories = await deps.github.searchRepositories(query, options.resultsPerQuery, scoutSignal);
        searches.push({ area: item.area, query, repositories }); pools.push(repositories);
        log(`Repository scout: ${item.area} search returned ${repositories.length} projects.`);
      } catch (error) {
        budget(); failures++;
        searches.push({ area: item.area, query, error: String(error) }); log(`Repository scout search failed: ${String(error)}`);
      }
      atomicJson(join(dir, 'searches.json'), searches);
    }
    if (!pools.length) throw new Error('All repository searches failed');
    // Round-robin across query results so the first ecosystem cannot take every slot.
    const excluded = new Set([...config.repositories.map(item => item.repo), ...options.excludeRepositories].map(name => name.toLowerCase()));
    const candidates: RepositoryFacts[] = [];
    for (let row = 0; row < options.resultsPerQuery; row++) for (const pool of pools) {
      const candidate = pool[row];
      if (candidate && !exclusion(candidate, config, excluded, now)) {
        excluded.add(candidate.repo.toLowerCase()); candidates.push(candidate);
      }
    }
    excluded.clear();
    for (const name of [...config.repositories.map(item => item.repo), ...options.excludeRepositories]) excluded.add(name.toLowerCase());
    for (const candidate of candidates.slice(0, options.maxCandidates)) {
      budget();
      try {
        const facts = await deps.github.repositoryFacts(candidate.repo, scoutSignal);
        const reason = exclusion(facts, config, excluded, now);
        if (reason) { screening.push({ repo: facts.repo, reason }); continue; }
        excluded.add(facts.repo.toLowerCase());
        const details = await deps.github.repositoryEvidence(facts, config, scoutSignal);
        if (!details.languages.some(language => ['TypeScript', 'JavaScript'].includes(language))) {
          screening.push({ repo: facts.repo, reason: 'No JavaScript/TypeScript code reported by GitHub' }); continue;
        }
        if (!details.issues.some(issue => !eligible(issue, config))) {
          screening.push({ repo: facts.repo, reason: 'No eligible issues in the bounded sample' }); continue;
        }
        evidence.push(details); screening.push({ repo: facts.repo, reason: 'Verified; sent for model assessment' });
        log(`Repository scout: verified ${facts.repo} (${facts.stars} stars).`);
      } catch (error) {
        budget(); failures++; screening.push({ repo: candidate.repo, reason: `Evidence fetch failed: ${String(error)}` });
        log(`Repository scout: ${candidate.repo}: ${String(error)}`);
      }
      atomicJson(join(dir, 'screening.json'), screening);
    }
    atomicJson(join(control, 'evidence.json'), evidence);
    if (!evidence.length && failures) throw new Error('No verified candidates after GitHub errors; retaining the previous catalog');
    if (evidence.length) scout.assessments = validateAssessments(await agent('scout-select', scoutSelectionSchema, {
      criteria: options.criteria, areas: options.areas, maxRepositories: options.maxRepositories,
      controlDirectory: control, candidates: evidence.map(item => item.facts.repo),
    }), evidence, config);
    scout.selected = scout.assessments.filter(item => item.decision === 'select')
      .sort((a, b) => b.priority - a.priority || a.repo.localeCompare(b.repo))
      .map(({ repo, area, priority }) => ({ repo, area, priority }));
    scout.retainedRepositories = retainBacklog(catalog, scout.selected, config, store.state.tasks);
    scoutSignal.throwIfAborted();
    scout.status = 'ready'; scout.reason = `${scout.selected.length} repositories selected from ${evidence.length} verified candidates; ${scout.retainedRepositories.length} previous repositories retained for pending work; ${failures} search/evidence errors.`;
  } catch (error) {
    scout.status = scoutSignal.aborted ? 'interrupted' : 'failed'; scout.reason = String(error instanceof Error ? error.message : error);
  } finally {
    if (created) try { await sandbox!.remove(); }
    catch (error) { scout.cleanupError = String(error); scout.status = 'failed'; scout.reason += `; Sandbox cleanup failed: ${scout.sandbox}; run recover`; }
    if (scout.status === 'ready' && scoutSignal.aborted) { scout.status = 'interrupted'; scout.reason = 'Repository scout deadline or cancellation before catalog activation'; }
    scout.finishedAt = new Date().toISOString();
    atomicJson(join(dir, 'searches.json'), searches); atomicJson(join(dir, 'screening.json'), screening);
    atomicJson(join(control, 'evidence.json'), evidence); persist();
  }
  if (scout.status === 'ready') {
    try {
      atomicJson(join(store.dir, 'repositories.json'), { version: 1, criteriaHash: criteriaHash(config), generatedAt: scout.finishedAt, scoutId: id, repositories: scout.selected, retainedRepositories: scout.retainedRepositories });
    } catch (error) { scout.status = 'failed'; scout.reason = `Catalog activation failed: ${String(error)}`; persist(); }
  }
  log(`Repository scout: ${scout.status} — ${scout.reason}`); log(`Scout report: ${join(dir, 'report.md')}`);
  return { tokens: scout.tokens, cached: false, scout };
}
