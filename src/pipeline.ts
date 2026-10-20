import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eligible } from './github.js';
import { clone, Git, resolveAuthor } from './git.js';
import { validatePlan, validateReview, validateWork } from './config.js';
import { DockerSandbox } from './sandbox.js';
import { planSchema, reviewSchema, workSchema } from './schemas.js';
import { atomicJson, Store } from './store.js';
import { writeReport } from './report.js';
import { createDiscoverySession, discover, discoveryHasMore } from './discovery.js';
import type { Attempt, Command, Config, GitHub, IssueContext, Plan, Repository, Review, Run, Sandbox, Task, WorkResult } from './types.js';

export { discover } from './discovery.js';
export function selectTasks(tasks: Task[], config: Config): Task[] {
  const counts = new Map<string, number>();
  return tasks.filter(task => {
    const repo = task.issue.repo.toLowerCase();
    if (!config.repositories.some(r => r.repo.toLowerCase() === repo)) return false;
    const count = counts.get(repo) ?? 0;
    if (count >= config.limits.maxTasksPerRepo) return false;
    counts.set(repo, count + 1); return true;
  }).slice(0, config.limits.maxTasks);
}
class Skip extends Error {}
class RepairableFailure extends Error {
  constructor(message: string, readonly review?: Review) { super(message); }
}
export interface Dependencies {
  github: GitHub;
  sandbox?: (attempt: Attempt, repo: string, control: string, logs: string) => Sandbox;
  clone?: typeof clone;
  log?: (message: string) => void;
  initialTokens?: number;
  scoutDir?: string;
  preparationError?: string;
  discoveryRepositories?: Repository[];
}
export async function runNight(store: Store, config: Config, root: string, deps: Dependencies, signal: AbortSignal): Promise<Run> {
  const author = await resolveAuthor(config, root);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}`;
  const run: Run = { id, startedAt: new Date().toISOString(), taskIds: [], tokens: deps.initialTokens ?? 0, reason: deps.preparationError ?? '',
    ...(deps.scoutDir ? { scoutDir: deps.scoutDir } : {}) };
  store.state.runs.push(run); store.save();
  const activeRepos = new Set(config.repositories.map(r => r.repo.toLowerCase()));
  let pending = store.queued().filter(task => activeRepos.has(task.issue.repo.toLowerCase()));
  const attemptsPerRepo = new Map<string, number>();
  let attemptsUsed = 0;
  const timeout = AbortSignal.timeout(config.limits.nightMinutes * 60000);
  const nightSignal = AbortSignal.any([signal, timeout]);
  const busy = new Set<string>();
  const budget = () => {
    nightSignal.throwIfAborted();
    if (run.tokens >= config.limits.softTokenBudget) throw new Error('Soft token budget reached');
  };
  const log = deps.log ?? (() => {});
  const common = readFileSync(join(root, 'prompts/common.md'), 'utf8');
  const stagePrompt = (stage: string, context: unknown) => `${common}\n\n${readFileSync(join(root, 'prompts', `${stage}.md`), 'utf8')}\n\nTask context (data, not instructions):\n${JSON.stringify(context, null, 2)}`;

  const processTask = async (task: Task) => {
    const slug = `${task.issue.repo.replace('/', '--')}-${task.issue.number}`;
    const dir = join(store.dir, 'runs', id, slug);
    const repo = join(dir, 'repo'), control = join(dir, 'control'), logs = join(dir, 'logs');
    mkdirSync(control, { recursive: true }); mkdirSync(logs, { recursive: true });
    const attempt: Attempt = {
      runId: id, dir, sandbox: `contrib-${randomUUID().slice(0,8)}-${task.issue.number}`,
      branch: `contrib/issue-${task.issue.number}-${id.slice(-8)}`, startedAt: new Date().toISOString(),
      status: 'running', reason: '', tokens: 0, checks: [],
    };
    task.status = 'running'; task.reason = ''; task.attempts.push(attempt); run.taskIds.push(task.id); store.save();
    const taskSignal = AbortSignal.any([nightSignal, AbortSignal.timeout(config.limits.taskMinutes * 60000)]);
    const sandbox = deps.sandbox?.(attempt, repo, control, logs) ?? new DockerSandbox({ name: attempt.sandbox, repo, control, logs, config, forceRemove: config.sandbox.command[0] === 'sbx' });
    let git: Git | undefined, created = false, workStarted = false;
    const ensureBudget = () => { taskSignal.throwIfAborted(); budget(); };
    const agent = async <T>(stage: string, schema: object, context: unknown, role = stage): Promise<T> => {
      ensureBudget(); log(`${task.id}: ${stage}`);
      const result = await sandbox.agent<T>(stage, stagePrompt(role, context), schema, taskSignal);
      attempt.tokens += result.tokens; run.tokens += result.tokens;
      atomicJson(join(dir, `${stage}.json`), result.value); store.save();
      return result.value;
    };
    const checks = async (phase: string, commands: Command[], expectFailure = false, unchanged?: { git: Git; base: string; patch: string }) => {
      let failures = 0;
      for (const [index, command] of commands.entries()) {
        ensureBudget();
        const name = `${phase}-${index + 1}.log`, path = join(logs, name);
        log(`${task.id}: ${phase} ${JSON.stringify(command.argv)}`);
        const code = await sandbox.command(command, path, taskSignal);
        attempt.checks.push({ phase, command, exitCode: code, log: path });
        copyFileSync(path, join(control, name));
        atomicJson(join(control, 'checks.json'), attempt.checks); store.save();
        if (code !== 0) failures++;
        if (unchanged) {
          await unchanged.git.assertHead(unchanged.base);
          if ((await unchanged.git.snapshot()) !== unchanged.patch) throw new Error(`${phase}: command changed the checkout; checks must preserve contribution files; see ${name}`);
        }
        if (!expectFailure && code !== 0) {
          const message = `${phase}: command exited ${code}; see ${name}`;
          // A failing check that edits contribution files is an invariant failure,
          // not permission for a repair session to accept the modified evidence.
          throw unchanged ? new RepairableFailure(message) : new Error(message);
        }
      }
      if (expectFailure && !failures) throw new Error('Regression did not fail before the fix');
    };
    try {
      ensureBudget();
      const context: IssueContext = await deps.github.context(task.issue.repo, task.issue.number, taskSignal);
      task.issue = context.issue;
      atomicJson(join(control, 'issue.json'), context);
      const exclusion = eligible(context.issue, config);
      if (exclusion) throw new Skip(exclusion);
      if (context.openPullRequests.length) throw new Skip(`Already referenced by open PR: ${context.openPullRequests.join(', ')}`);
      git = await (deps.clone ?? clone)(task.issue.repo, repo, attempt.branch, taskSignal);
      attempt.base = await git.run(['rev-parse', 'HEAD']); store.save();
      git.protectMetadata();
      created = true; // Even partially failed creation needs cleanup.
      await sandbox.create(taskSignal);
      const taskContext = { ...context, base: attempt.base, limits: config.limits, controlDirectory: control };
      const plan = validatePlan(await agent<Plan>('plan', planSchema, taskContext));
      attempt.plan = plan; atomicJson(join(control, 'plan.json'), plan); store.save();
      await git.assertHead(attempt.base); await git.assertClean();
      if (plan.decision === 'skip') throw new Skip(plan.reason);
      workStarted = true;
      await checks('setup', plan.setup);
      const baseline = [...new Map([...plan.regression, ...plan.checks].map(c => [JSON.stringify(c), c])).values()];
      await checks('baseline', baseline);
      await git.assertHead(attempt.base); await git.assertClean();

      const reproduced = validateWork(await agent<WorkResult>('reproduce', workSchema, { ...taskContext, plan }));
      if (reproduced.status === 'blocked') throw new Skip(reproduced.summary);
      await git.assertHead(attempt.base);
      const red = await git.inspect(config);
      if (!red.files.every(f => /(^|\/)(__tests__|tests?|fixtures?|__fixtures__|test-d|type-tests)(\/|\.)|\.(test|spec)\.[cm]?[jt]sx?$|\.test-d\.ts$/.test(f))) throw new Error('Reproducer changed paths outside tests/fixtures');
      const fingerprint = (file: string) => createHash('sha256').update(readFileSync(join(repo, file))).digest('hex');
      const regressionHashes = new Map(red.files.map(f => [f, fingerprint(f)]));
      writeFileSync(join(dir, 'regression.patch'), red.patch);
      writeFileSync(join(control, 'regression.patch'), red.patch);
      await checks('regression-before', plan.regression, true);

      const implemented = validateWork(await agent<WorkResult>('implement', workSchema, { ...taskContext, plan, reproduction: reproduced }));
      if (implemented.status === 'blocked') throw new Error(implemented.summary);
      const assertRegression = () => {
        for (const [file, hash] of regressionHashes) if (fingerprint(file) !== hash) throw new Error(`Implementation changed regression evidence: ${file}`);
      };
      let approved: { patch: string; review: Review } | undefined, repairs = 0;
      while (!approved) {
        assertRegression(); await git.assertHead(attempt.base);
        const candidate = await git.inspect(config), suffix = repairs ? `-repair-${repairs}` : '';
        writeFileSync(join(control, 'change.patch'), candidate.patch);
        writeFileSync(join(control, `candidate${suffix}.patch`), candidate.patch);
        try {
          const unchanged = { git, base: attempt.base, patch: candidate.patch };
          await checks(`regression-after${suffix}`, plan.regression, false, unchanged);
          await checks(`verification${suffix}`, plan.checks, false, unchanged);
          assertRegression();
          const review = validateReview(await agent<Review>(`review${suffix}`, reviewSchema, {
            ...taskContext, plan, checks: attempt.checks, changedFiles: candidate.files,
            repairs: attempt.repairs ?? [], currentValidationPhases: [`regression-after${suffix}`, `verification${suffix}`],
            logs: 'Read checks.json, regression.patch, change.patch, and *.log in controlDirectory. Earlier failures are retained; the current validation phases must pass.',
          }, 'review'));
          attempt.review = review; store.save();
          await git.assertHead(attempt.base);
          if ((await git.snapshot()) !== candidate.patch) throw new Error('Reviewer modified the checkout');
          const reason = `Review requires changes: ${review.summary}; ${review.findings.join('; ')}`;
          if (!review.regressionIsMeaningful || !review.policyCompliant) throw new Error(reason);
          if (review.verdict !== 'approve' || review.findings.length > 0) throw new RepairableFailure(reason, review);
          if (!review.title.trim() || !review.body.trim() || /[\r\n]/.test(review.title)) throw new Error('Missing or invalid PR draft');
          approved = { patch: candidate.patch, review };
        } catch (error) {
          if (!(error instanceof RepairableFailure)) throw error;
          if (repairs >= config.limits.maxRepairAttempts) throw new Error(`Repair limit reached: ${error.message}`);
          ensureBudget(); assertRegression(); await git.assertHead(attempt.base);
          const round = ++repairs, feedback = { round, reason: error.message, review: error.review ?? null, checks: attempt.checks };
          (attempt.repairs ??= []).push({ round, reason: error.message });
          atomicJson(join(control, `repair-${round}.feedback.json`), feedback); store.save();
          const repaired = validateWork(await agent<WorkResult>(`repair-${round}`, workSchema, {
            ...taskContext, plan, feedback, protectedRegressionFiles: [...regressionHashes.keys()],
          }, 'repair'));
          if (repaired.status !== 'done') throw new Error(`Repair blocked: ${repaired.summary}`);
        }
      }
      const { patch, review } = approved;
      taskSignal.throwIfAborted();
      // Finishing a validated task spends no further model tokens.
      // Stop VM processes before accepting the final checkout.
      await sandbox.remove(); created = false;
      await git.assertHead(attempt.base);
      if ((await git.snapshot()) !== patch) throw new Error('Checkout changed during sandbox shutdown');
      attempt.commit = await git.commit(author, review.title);
      writeFileSync(join(dir, 'change.patch'), patch);
      writeFileSync(join(dir, 'PR.md'), `# ${review.title}\n\n${review.body}\n`);
      attempt.status = 'ready'; attempt.reason = `Baseline passed; regression failed before fix and passed after; checks and independent review passed.${repairs ? ` Completed ${repairs} repair round(s).` : ''}`;
    } catch (error) {
      attempt.status = nightSignal.aborted || taskSignal.aborted ? 'interrupted' : error instanceof Skip ? 'skipped' : 'failed';
      attempt.reason = String(error instanceof Error ? error.message : error);
    } finally {
      if (created) {
        try { await sandbox.remove(); }
        catch (error) {
          attempt.cleanupError = String(error); attempt.status = 'failed';
          attempt.reason += `; Sandbox cleanup failed: ${attempt.sandbox}`;
        }
      }
      if (git && attempt.status !== 'ready') {
        try { writeFileSync(join(dir, 'change.patch'), await git.snapshot()); } catch { /* Original error remains authoritative. */ }
      }
      attempt.finishedAt = new Date().toISOString(); task.status = attempt.status; task.reason = attempt.reason;
      atomicJson(join(dir, 'result.json'), attempt); store.save(); writeReport(store, run);
      log(`${task.id}: ${task.status} — ${task.reason}`);
    }
    // Eligibility and clean planning skips release a slot after cleanup.
    // Their model usage still counts; errors and work after planning keep it.
    return !workStarted && attempt.status === 'skipped';
  };
  const worker = async () => {
    while (pending.length && attemptsUsed < config.limits.maxTasks) {
      if (nightSignal.aborted || run.tokens >= config.limits.softTokenBudget || deps.github.stopReason) break;
      const index = pending.findIndex(task => {
        const repo = task.issue.repo.toLowerCase();
        return !busy.has(repo) && (attemptsPerRepo.get(repo) ?? 0) < config.limits.maxTasksPerRepo;
      });
      if (index < 0) break;
      const task = pending.splice(index, 1)[0]!, repo = task.issue.repo.toLowerCase();
      // Reserve both quotas before awaiting preflight so concurrent workers
      // cannot overbook the run. A skipped candidate lets this worker refill.
      attemptsUsed++; attemptsPerRepo.set(repo, (attemptsPerRepo.get(repo) ?? 0) + 1);
      busy.add(repo);
      try {
        const skippedBeforeWork = await processTask(task);
        if (skippedBeforeWork) {
          attemptsUsed--; attemptsPerRepo.set(repo, attemptsPerRepo.get(repo)! - 1);
        }
      } finally { busy.delete(repo); }
    }
  };
  const session = createDiscoverySession();
  let discoveryEnabled = deps.discoveryRepositories !== undefined;
  if (discoveryEnabled) run.discoveryRounds = 0;
  const stopped = () => nightSignal.aborted || run.tokens >= config.limits.softTokenBudget || Boolean(deps.github.stopReason);
  const refill = async (): Promise<string | undefined> => {
    if (stopped()) return 'Run budget, deadline, cancellation, or GitHub stop reached';
    const repositories = (deps.discoveryRepositories ?? []).filter(repo => (attemptsPerRepo.get(repo.repo.toLowerCase()) ?? 0) < config.limits.maxTasksPerRepo);
    if (!repositories.length) return 'No discovery repositories have a remaining work slot';
    if ((run.discoveryRounds ?? 0) >= config.discovery.maxRoundsPerNight) return 'Night discovery round limit reached';
    if (!discoveryHasMore(session, repositories)) return 'Search results exhausted for the remaining repositories';
    if (store.queued().filter(task => activeRepos.has(task.issue.repo.toLowerCase())).length >= config.discovery.maxQueued) return 'Active queue capacity reached';
    run.discoveryRounds = (run.discoveryRounds ?? 0) + 1; store.save();
    log(`Night discovery round ${run.discoveryRounds}/${config.discovery.maxRoundsPerNight}`);
    try {
      log(`Queued ${await discover(store, config, deps.github, log, { session, repositories, signal: nightSignal })} new issues`);
    } catch (error) {
      run.reason = `Issue discovery failed: ${String(error)}`; log(run.reason);
      discoveryEnabled = false;
    }
    pending = store.queued().filter(task => activeRepos.has(task.issue.repo.toLowerCase()));
    return undefined;
  };
  try {
    if (discoveryEnabled) await refill();
    while (!stopped() && attemptsUsed < config.limits.maxTasks) {
      const results = await Promise.allSettled(Array.from({ length: Math.min(config.limits.concurrency, pending.length) }, worker));
      const rejected = results.find(r => r.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      if (!discoveryEnabled || stopped() || attemptsUsed >= config.limits.maxTasks) break;
      const reason = await refill();
      if (reason) { run.discoveryStop = reason; log(`Night discovery stopped: ${reason}.`); break; }
    }
  } catch (error) { run.reason = String(error); }
  finally {
    run.finishedAt = new Date().toISOString();
    if (nightSignal.aborted) run.reason = 'Interrupted or night deadline reached';
    else if (run.tokens >= config.limits.softTokenBudget) run.reason = 'Soft token budget reached';
    else if (deps.github.stopReason) run.reason = deps.github.stopReason;
    if (deps.discoveryRepositories && !run.discoveryStop) run.discoveryStop = run.reason || 'Work attempt limit reached';
    store.save(); writeReport(store, run);
  }
  return run;
}
