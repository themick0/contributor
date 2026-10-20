import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Command, Config, Plan, Review, WorkResult } from './types.js';

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
export const validRepo = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(s) && !s.endsWith('/..');
export function loadConfig(path: string): Config {
  const c: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert(record(c) && c.version === 1, 'Configuration must have version: 1');
  assert(nonempty(c.stateDir) && !isAbsolute(c.stateDir) && !c.stateDir.split(/[\\/]/).includes('..') && resolve('/config', c.stateDir) !== '/config', 'stateDir must be a subdirectory');
  assert(record(c.sandbox) && Array.isArray(c.sandbox.command), 'sandbox.command must be an argv array');
  const driver = JSON.stringify(c.sandbox.command);
  assert(driver === '["docker","sandbox"]' || driver === '["sbx"]', 'sandbox.command must be ["docker", "sandbox"] or ["sbx"]');
  assert(c.sandbox.template === null || nonempty(c.sandbox.template), 'Invalid sandbox.template');
  assert(record(c.codex) && (c.codex.model === null || nonempty(c.codex.model)), 'Invalid codex.model');
  assert(record(c.limits), 'Missing limits');
  c.limits.maxRepairAttempts ??= 2;
  assert(Number.isSafeInteger(c.limits.maxRepairAttempts) && Number(c.limits.maxRepairAttempts) >= 0 && Number(c.limits.maxRepairAttempts) <= 5, 'limits.maxRepairAttempts must be an integer from 0 to 5');
  const limits = ['concurrency', 'maxTasks', 'maxTasksPerRepo', 'nightMinutes', 'taskMinutes', 'agentMinutes', 'commandMinutes', 'softTokenBudget', 'maxChangedFiles', 'maxChangedLines'];
  for (const key of limits) assert(Number.isSafeInteger(c.limits[key]) && Number(c.limits[key]) > 0, `limits.${key} must be a positive integer`);
  assert(Number(c.limits.concurrency) <= 8, 'concurrency must be <= 8');
  assert(record(c.discovery), 'Missing discovery');
  c.discovery.maxPagesPerRepo ??= 3;
  c.discovery.maxCandidateChecks ??= 60;
  c.discovery.maxRoundsPerNight ??= 12;
  for (const key of ['issuesPerRepo', 'maxQueued', 'minScore', 'maxPagesPerRepo', 'maxCandidateChecks', 'maxRoundsPerNight']) assert(Number.isSafeInteger(c.discovery[key]) && Number(c.discovery[key]) > 0, `Invalid discovery.${key}`);
  assert(Number(c.discovery.maxRoundsPerNight) <= 100, 'maxRoundsPerNight must be <= 100');
  assert(Number(c.discovery.issuesPerRepo) <= 100, 'issuesPerRepo must be <= 100');
  assert(Number(c.discovery.issuesPerRepo) * Number(c.discovery.maxPagesPerRepo) <= 1000, 'Discovery pagination must stay within GitHub\'s 1000-result search limit');
  for (const key of ['includeLabels', 'excludeLabels']) assert(Array.isArray(c.discovery[key]) && (c.discovery[key] as unknown[]).every(nonempty), `Invalid discovery.${key}`);
  assert(c.author === null || (record(c.author) && nonempty(c.author.name) && nonempty(c.author.email)), 'author must be null or {name, email}');
  assert(Array.isArray(c.repositories) && c.repositories.length > 0, 'Add at least one repository');
  const names = new Set<string>();
  for (const repo of c.repositories) {
    assert(record(repo) && typeof repo.repo === 'string' && validRepo(repo.repo) && nonempty(repo.area) && Number.isInteger(repo.priority) && Number(repo.priority) >= 1 && Number(repo.priority) <= 5, 'Invalid repository entry');
    assert(!names.has(repo.repo.toLowerCase()), `Duplicate repository: ${repo.repo}`);
    names.add(repo.repo.toLowerCase());
  }
  const scoutDefaults: Config['repositoryDiscovery'] = {
    enabled: true,
    criteria: 'Established DeFi SDKs, frontend libraries, TypeScript and Node.js packages, and developer utilities with useful, testable JavaScript/TypeScript contribution opportunities. Prefer active maintainers and evidence of external contributions. Exclude applications, demos, tutorials, and projects that prohibit this workflow.',
    areas: ['defi', 'frontend', 'typescript', 'node'], excludeRepositories: [],
    minStars: 1000, maxInactiveDays: 180, maxQueries: 6, resultsPerQuery: 10,
    maxCandidates: 12, maxRepositories: 6, refreshHours: 24, minutes: 30,
    issuesPerPage: 20, maxIssuePages: 3, issueSamples: 5,
    softTokenBudget: Math.min(200000, Number(c.limits.softTokenBudget)),
  };
  assert(c.repositoryDiscovery === undefined || record(c.repositoryDiscovery), 'Invalid repositoryDiscovery');
  const scout = { ...scoutDefaults, ...(c.repositoryDiscovery as Record<string, unknown> | undefined) };
  assert(typeof scout.enabled === 'boolean' && nonempty(scout.criteria) && scout.criteria.length <= 12000, 'Invalid repository discovery criteria');
  assert(Array.isArray(scout.areas) && scout.areas.length > 0 && scout.areas.length <= 8 && scout.areas.every(area => typeof area === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(area)), 'Invalid repository discovery areas');
  assert(new Set(scout.areas).size === scout.areas.length, 'Repository discovery areas must be unique');
  assert(Array.isArray(scout.excludeRepositories) && scout.excludeRepositories.every(repo => typeof repo === 'string' && validRepo(repo) && !names.has(repo.toLowerCase())), 'Excluded repositories must be valid and absent from the pinned list');
  for (const key of ['minStars', 'maxInactiveDays', 'maxQueries', 'resultsPerQuery', 'maxCandidates', 'maxRepositories', 'refreshHours', 'minutes', 'softTokenBudget', 'issuesPerPage', 'maxIssuePages', 'issueSamples'] as const) {
    assert(Number.isSafeInteger(scout[key]) && Number(scout[key]) > 0, `Invalid repositoryDiscovery.${key}`);
  }
  assert(scout.maxQueries <= 12 && scout.resultsPerQuery <= 100 && scout.maxCandidates <= 50 && scout.maxRepositories <= scout.maxCandidates, 'Repository discovery bounds are too large or inconsistent');
  assert(scout.issuesPerPage <= 100 && scout.maxIssuePages <= 10 && scout.issuesPerPage * scout.maxIssuePages <= 1000
    && scout.issueSamples <= 10 && scout.issueSamples <= scout.issuesPerPage * scout.maxIssuePages, 'Invalid repository issue sampling bounds');
  c.repositoryDiscovery = scout;
  return c as unknown as Config;
}
export function commandPath(root: string, command: Command): string {
  assert(record(command) && Array.isArray(command.argv) && command.argv.length > 0 && command.argv.length <= 64 && command.argv.every(x => typeof x === 'string' && !x.includes('\0')), 'Command needs argv');
  assert(nonempty(command.argv[0]) && !command.argv[0].startsWith('-'), 'Invalid executable');
  assert(typeof command.cwd === 'string' && !isAbsolute(command.cwd) && !command.cwd.includes('\\') && !command.cwd.split('/').includes('..'), 'Command cwd must stay inside checkout');
  return resolve(root, command.cwd);
}
export function validatePlan(p: Plan): Plan {
  assert(record(p) && ['implement', 'skip'].includes(p.decision), 'Invalid planner decision');
  for (const s of [p.reason, p.summary, p.contributionPolicy]) assert(typeof s === 'string', 'Invalid planner text');
  for (const group of [p.setup, p.regression, p.checks]) {
    assert(Array.isArray(group) && group.length <= 12, 'Invalid command list');
    group.forEach(c => commandPath('/checkout', c));
  }
  if (p.decision === 'implement') {
    assert(p.regression.length > 0 && p.checks.length > 0, 'A fix needs regression commands and verification commands');
    assert(nonempty(p.contributionPolicy), 'Planner must describe contribution policy');
  }
  return p;
}
export function validateWork(w: WorkResult): WorkResult {
  assert(record(w) && ['done', 'blocked'].includes(w.status) && typeof w.summary === 'string', 'Invalid worker result');
  return w;
}
export function validateReview(r: Review): Review {
  assert(record(r) && ['approve', 'changes_requested'].includes(r.verdict), 'Invalid reviewer verdict');
  assert(typeof r.summary === 'string' && typeof r.title === 'string' && typeof r.body === 'string' && Array.isArray(r.findings) && r.findings.every(x => typeof x === 'string'), 'Invalid review output');
  assert(typeof r.regressionIsMeaningful === 'boolean' && typeof r.policyCompliant === 'boolean', 'Review must check regression and contribution policy');
  return r;
}
