export interface Config {
  version: 1;
  stateDir: string;
  sandbox: { command: string[]; template: string | null };
  codex: { model: string | null };
  limits: {
    concurrency: number; maxTasks: number; maxTasksPerRepo: number;
    nightMinutes: number; taskMinutes: number; agentMinutes: number;
    commandMinutes: number; softTokenBudget: number;
    maxChangedFiles: number; maxChangedLines: number; maxRepairAttempts: number;
  };
  discovery: {
    issuesPerRepo: number; maxQueued: number; minScore: number;
    maxPagesPerRepo: number; maxCandidateChecks: number; maxRoundsPerNight: number;
    includeLabels: string[]; excludeLabels: string[];
  };
  repositoryDiscovery: {
    enabled: boolean; criteria: string; areas: string[]; excludeRepositories: string[];
    minStars: number; maxInactiveDays: number; maxQueries: number;
    resultsPerQuery: number; maxCandidates: number; maxRepositories: number;
    refreshHours: number; minutes: number; softTokenBudget: number;
    issuesPerPage: number; maxIssuePages: number; issueSamples: number;
  };
  author: { name: string; email: string } | null;
  repositories: Repository[];
}
export interface Repository { repo: string; area: string; priority: number }
export interface RepositoryFacts {
  repo: string; description: string; stars: number; pushedAt: string;
  archived: boolean; disabled: boolean; fork: boolean; private: boolean;
  language: string | null; license: string | null; topics: string[];
}
export interface RepositoryEvidence {
  facts: RepositoryFacts; languages: string[]; issues: Issue[];
  sources: Record<string, string>;
}
export interface RepositoryResearch {
  readonly stopReason?: string | undefined;
  searchRepositories(query: string, limit: number, signal?: AbortSignal): Promise<RepositoryFacts[]>;
  repositoryFacts(repo: string, signal?: AbortSignal): Promise<RepositoryFacts>;
  repositoryEvidence(facts: RepositoryFacts, config: Config, signal?: AbortSignal): Promise<RepositoryEvidence>;
}
export interface RepositoryAssessment {
  repo: string; decision: 'select' | 'reject'; area: string; priority: number;
  reason: string; policy: 'allowed' | 'unspecified' | 'prohibited' | 'permission_required' | 'unclear';
  evidence: { source: string; quote: string }[];
}
export interface ScoutRun {
  id: string; dir: string; sandbox: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'ready' | 'failed' | 'interrupted'; reason: string;
  tokens: number; selected: Repository[]; assessments: RepositoryAssessment[]; cleanupError?: string;
  retainedRepositories?: Repository[];
}
export interface Issue {
  repo: string; number: number; title: string; body: string; url: string;
  state: string; labels: string[]; assignees: string[]; updatedAt: string;
}
export interface IssueContext { issue: Issue; comments: string[]; openPullRequests: string[] }
export type Status = 'queued' | 'running' | 'ready' | 'skipped' | 'failed' | 'interrupted';
export interface Task {
  id: string; issue: Issue; score: number; status: Status; reason: string;
  createdAt: string; attempts: Attempt[];
}
export interface Command { argv: string[]; cwd: string }
export interface Plan {
  decision: 'implement' | 'skip'; reason: string; summary: string;
  contributionPolicy: string; setup: Command[]; regression: Command[]; checks: Command[];
}
export interface WorkResult { status: 'done' | 'blocked'; summary: string }
export interface Review {
  verdict: 'approve' | 'changes_requested'; summary: string; findings: string[];
  regressionIsMeaningful: boolean; policyCompliant: boolean;
  title: string; body: string;
}
export interface Check {
  phase: string; command: Command; exitCode: number; log: string;
}
export interface Attempt {
  runId: string; dir: string; sandbox: string; branch: string;
  startedAt: string; finishedAt?: string; status: Status; reason: string;
  base?: string; commit?: string; tokens: number; checks: Check[];
  plan?: Plan; review?: Review; cleanupError?: string;
  repairs?: { round: number; reason: string }[];
}
export interface Run {
  id: string; startedAt: string; finishedAt?: string; taskIds: string[];
  tokens: number; reason: string;
  scoutDir?: string;
  discoveryRounds?: number;
  discoveryStop?: string;
}
export interface State { version: 1; tasks: Task[]; runs: Run[]; scouts?: ScoutRun[] }
export interface AgentResult<T> { value: T; tokens: number }
export interface Sandbox {
  create(signal: AbortSignal): Promise<void>;
  agent<T>(stage: string, prompt: string, schema: object, signal: AbortSignal): Promise<AgentResult<T>>;
  command(command: Command, log: string, signal: AbortSignal): Promise<number>;
  remove(): Promise<void>;
}
export interface GitHub {
  readonly stopReason?: string | undefined;
  search(repo: string, limit: number, page?: number, signal?: AbortSignal): Promise<Issue[]>;
  context(repo: string, number: number, signal?: AbortSignal): Promise<IssueContext>;
}
