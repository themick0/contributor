import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadConfig, validateWork } from './config.js';
import { resolveAuthor } from './git.js';
import { doctor, sandboxCapabilities } from './doctor.js';
import { eligible, GitHubClient, parseIssueUrl, scoreIssue } from './github.js';
import { discover, runNight, selectTasks } from './pipeline.js';
import { checked } from './process.js';
import { writeReport } from './report.js';
import { catalogFresh, readCatalog, scoutIdPattern, withCatalog } from './repositories.js';
import { DockerSandbox } from './sandbox.js';
import { scoutRepositories, writeScoutReport, type ScoutResult } from './scout.js';
import { writeSchedule } from './schedule.js';
import { workSchema } from './schemas.js';
import { atomicJson, Store } from './store.js';
import type { Config, WorkResult } from './types.js';

const codeRoot = fileURLToPath(new URL('../../', import.meta.url));
const help = `night-contributor — Codex CLI in Docker Sandboxes, local artifacts only

  doctor [--probe]       Check host tools/auth; --probe also runs a real model smoke test
  scout [--dry-run]      Use AI and GitHub evidence to refresh candidate repositories
  discover              Read GitHub issues and rank/enqueue candidates
  enqueue <issue-url>   Enqueue one issue in an allowed repository
  queue                 Show persistent queue and outcomes
  run [--dry-run]        Process queued issues
  night [--dry-run]      Refresh scout if due; process and refill issues within run limits
  report                Print latest morning report
  retry <owner/repo#n>   Requeue failed/skipped/interrupted work explicitly
  recover               Clean orphan sandboxes and mark interrupted work after a crash
  schedule [--hour 1]    Generate launchd/cron files; does not install a schedule

  --config <path>        Default: ./contributor.config.json
  --json                JSON output for queue/doctor/dry-run
`;

async function probe(config: Config, store: Store, signal: AbortSignal): Promise<void> {
  const capability = await sandboxCapabilities(config);
  const dir = join(store.dir, 'probes', randomUUID());
  const repo = join(dir, 'repo'), control = join(dir, 'control'), logs = join(dir, 'logs');
  mkdirSync(repo, { recursive: true });
  await checked(['git', 'init', '--quiet', repo]);
  const sandbox = new DockerSandbox({ name: `contrib-${randomUUID().slice(0,8)}-0`, repo, control, logs, config, ...capability });
  try {
    await sandbox.create(signal);
    const result = await sandbox.agent<WorkResult>('probe', 'This is an authentication and structured-output smoke test. Do not modify files or contact GitHub. Return status="done" and summary="Sandbox Codex is ready".', workSchema, signal);
    if (validateWork(result.value).status !== 'done') throw new Error(result.value.summary);
    console.log(`Sandbox model probe passed (${result.tokens} tokens). Logs: ${logs}`);
  } finally { await sandbox.remove(); }
}

async function recover(config: Config, store: Store): Promise<void> {
  const recoveryPath = join(store.dir, 'recovery.lock');
  writeFileSync(recoveryPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  let unlock: (() => void) | undefined;
  try {
    const lock = join(store.dir, 'runner.lock');
    if (existsSync(lock)) {
      const owner = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid runner.lock; inspect it manually');
      let live = true;
      try { process.kill(owner.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false; else throw error; }
      if (live) throw new Error(`Runner PID ${owner.pid} is still alive; stop it before recovery`);
      rmSync(lock);
    }
    unlock = store.lock();
    const pending = store.state.tasks.flatMap(task => task.attempts.filter(a => a.status === 'running' || a.cleanupError).map(attempt => ({ task, attempt })));
    const scouts = (store.state.scouts ?? []).filter(scout => scout.status === 'running' || scout.cleanupError);
    const targets = [...pending, ...scouts.map(scout => ({ scout, attempt: scout }))];
    const updatedRuns = new Set<string>();
    let failures = 0;
    if (targets.length) {
      const caps = await sandboxCapabilities(config);
      for (const target of targets) {
        const { attempt } = target;
        if ('scout' in target && (!scoutIdPattern.test(target.scout.id) || target.scout.dir !== join(store.dir, 'scouts', target.scout.id))) throw new Error('Invalid scout recovery path');
        if (!/^contrib-[a-f0-9]{8}-\d+$/.test(attempt.sandbox)) throw new Error('Refusing to remove an unrecognized sandbox name');
        const sandbox = new DockerSandbox({ name: attempt.sandbox, repo: join(attempt.dir, 'repo'), control: join(attempt.dir, 'control'), logs: join(attempt.dir, 'logs'), config, ...caps });
        try {
          // A removed sandbox may be absent already. Only skip removal when the list proves that.
          const listed = await checked([...config.sandbox.command, 'ls', '--json']);
          const data: unknown = JSON.parse(listed);
          const rows = Array.isArray(data) ? data : (data as { sandboxes?: unknown[] }).sandboxes;
          if (!Array.isArray(rows)) throw new Error('Unrecognized sandbox list response');
          const names = rows.map((row: { name?: string; Name?: string }) => row.name ?? row.Name);
          if (names.some(n => typeof n !== 'string')) throw new Error('Cannot safely identify sandboxes');
          if (names.includes(attempt.sandbox)) await sandbox.remove();
          delete attempt.cleanupError;
          attempt.status = 'interrupted'; attempt.reason = 'scout' in target
            ? 'Recovered repository scout; rerun scout or night to refresh the catalog'
            : 'Recovered after runner interruption; use retry explicitly';
        } catch (error) {
          attempt.cleanupError = String(error); attempt.status = 'failed';
          attempt.reason = `Sandbox cleanup failed during recovery: ${attempt.sandbox}; run recover again`;
          failures++; console.error(`${attempt.sandbox}: ${String(error)}`); process.exitCode = 1;
        }
        attempt.finishedAt = new Date().toISOString();
        atomicJson(join(attempt.dir, 'result.json'), attempt);
        if ('scout' in target) writeScoutReport(target.scout);
        else {
          const { task, attempt: taskAttempt } = target;
          if (task.attempts.at(-1) === taskAttempt) { task.status = taskAttempt.status; task.reason = taskAttempt.reason; }
          updatedRuns.add(taskAttempt.runId);
        }
      }
    }
    for (const run of store.state.runs) {
      if (!run.finishedAt || updatedRuns.has(run.id)) {
        run.finishedAt ??= new Date().toISOString();
        run.reason = pending.some(p => p.attempt.runId === run.id && p.attempt.cleanupError)
          ? 'Recovery incomplete: sandbox cleanup failed; run recover again' : 'Recovered after interruption';
        writeReport(store, run); updatedRuns.add(run.id);
      }
    }
    // Refreshing an older run must not make latest-report.md point backwards.
    const latest = store.state.runs.at(-1);
    if (latest && updatedRuns.size && !updatedRuns.has(latest.id)) writeReport(store, latest);
    // Keep attempts pending on disk if artifact generation or recovery is interrupted.
    store.save();
    console.log(failures ? `Recovery incomplete: ${failures} sandbox cleanup(s) failed; run recover again.` : 'Recovery completed. Inspect queue before retrying tasks.');
  } finally { unlock?.(); rmSync(recoveryPath); }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string', default: 'contributor.config.json' }, 'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }, probe: { type: 'boolean', default: false },
    hour: { type: 'string', default: '1' }, help: { type: 'boolean', short: 'h', default: false },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { console.log(help); return; }
  const configPath = resolve(values.config), root = dirname(configPath);
  const baseConfig = loadConfig(configPath), store = new Store(resolve(root, baseConfig.stateDir));
  let config = baseConfig;
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort()); process.on('SIGTERM', () => controller.abort());
  const signal = ['run', 'night'].includes(command)
    ? AbortSignal.any([controller.signal, AbortSignal.timeout(config.limits.nightMinutes * 60000)]) : controller.signal;
  const github = new GitHubClient(undefined, signal, { cooldownPath: join(store.dir, 'github-cooldown.json') });
  const log = (s: string) => console.log(s);
  if (command === 'queue') {
    const rows = store.state.tasks.map(t => ({ id: t.id, score: t.score, status: t.status, attempts: t.attempts.length, reason: t.reason }));
    if (values.json) console.log(JSON.stringify(rows, null, 2)); else console.table(rows);
    return;
  }
  if (command === 'report') {
    const run = store.state.runs.at(-1);
    if (!run) { console.log('No runs yet.'); return; }
    console.log(readFileSync(join(store.dir, 'runs', run.id, 'report.md'), 'utf8')); return;
  }
  if (command === 'doctor') {
    const checks = await doctor(config, root, undefined, () => github.login());
    if (values.json) console.log(JSON.stringify(checks, null, 2));
    else checks.forEach(c => log(`${c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail}`));
    if (checks.some(c => !c.ok)) { process.exitCode = 1; return; }
    if (values.probe) await probe(config, store, controller.signal);
    return;
  }
  if (command === 'schedule') {
    log(writeSchedule(store.dir, root, configPath, Number(values.hour)).join('\n')); return;
  }
  if (command === 'recover') { await recover(config, store); return; }
  if (['run', 'night', 'scout'].includes(command) && values['dry-run']) {
    const catalog = readCatalog(store, baseConfig, message => console.error(message));
    config = withCatalog(baseConfig, catalog, store.queued());
    console.log(JSON.stringify({ mode: 'local-artifacts', sandbox: config.sandbox.command, limits: config.limits,
      repositories: config.repositories.map(r => r.repo), tasks: selectTasks(store.queued(), config).map(t => t.id),
      repositoryDiscovery: { ...config.repositoryDiscovery, refreshDue: config.repositoryDiscovery.enabled && (command === 'scout' || command === 'night' && !catalogFresh(catalog, baseConfig)) },
      note: 'Offline preview only. No GitHub calls, sandbox creation, model requests, commits, or publication. night scouts repositories and refills issues within shared run limits; run uses the saved queue. Previously accepted queued work remains eligible after catalog rotation.' }, null, 2)); return;
  }
  if (!['scout', 'discover', 'enqueue', 'retry', 'run', 'night'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  const unlock = store.lock();
  try {
    if (command === 'retry') {
      const task = store.state.tasks.find(t => t.id === positionals[1]?.toLowerCase());
      if (!task || !['failed', 'skipped', 'interrupted'].includes(task.status)) throw new Error('retry requires a failed/skipped/interrupted owner/repo#number');
      if (task.attempts.some(a => a.cleanupError)) throw new Error('Run recover to remove the remaining sandbox before retry');
      task.status = 'queued'; task.reason = ''; store.save(); log(`Queued ${task.id}`); return;
    }
    config = withCatalog(baseConfig, readCatalog(store, baseConfig, log));
    if (command === 'enqueue') {
      const input = parseIssueUrl(positionals[1] ?? '');
      const repository = config.repositories.find(r => r.repo.toLowerCase() === input.repo.toLowerCase());
      if (!repository) throw new Error('Repository is not in the pinned list or active scout catalog');
      const context = await github.context(repository.repo, input.number);
      const reason = eligible(context.issue, config);
      if (reason || context.openPullRequests.length) throw new Error(reason ?? 'Issue already has an open referenced PR');
      log(store.enqueue(context.issue, scoreIssue(context.issue, repository, config)) ? 'Issue queued' : 'Issue already exists in history; use retry for an intentional new attempt'); return;
    }
    if (command === 'discover') { log(`Queued ${await discover(store, config, github, log)} new issues`); return; }
    if (command === 'scout' && !config.repositoryDiscovery.enabled) throw new Error('Repository discovery is disabled; set repositoryDiscovery.enabled to true');
    const diagnostics = await doctor(config, root, undefined, () => github.login());
    const failed = diagnostics.filter(d => !d.ok);
    if (failed.length) throw new Error(failed.map(d => `${d.name}: ${d.detail}`).join('\n'));
    const capabilities = await sandboxCapabilities(config);
    let scouting: ScoutResult | undefined;
    if (command === 'scout' || command === 'night') {
      scouting = await scoutRepositories(store, baseConfig, codeRoot, {
        github, log, sandbox: (scout, repo, control, logs) => new DockerSandbox({ name: scout.sandbox, repo, control, logs, config: baseConfig, ...capabilities }),
      }, signal, command === 'scout');
      if (scouting.scout?.cleanupError) throw new Error('Repository scout sandbox cleanup failed; run recover before continuing');
      if (command === 'scout') { if (scouting.scout?.status !== 'ready') process.exitCode = 1; return; }
      if (scouting.scout && scouting.scout.status !== 'ready') log('Repository scout did not refresh the catalog; continuing with previously verified or pinned targets.');
      config = withCatalog(baseConfig, readCatalog(store, baseConfig, log));
    }
    const discoveryRepositories = config.repositories;
    config = withCatalog(baseConfig, readCatalog(store, baseConfig, log), store.queued());
    const runConfig = { ...config, author: await resolveAuthor(config, root) };
    const run = await runNight(store, runConfig, codeRoot, {
      github, log, initialTokens: scouting?.tokens ?? 0,
      ...(command === 'night' ? { discoveryRepositories } : {}),
      ...(scouting?.scout ? { scoutDir: scouting.scout.dir } : {}),
      sandbox: (a, repo, control, logs) => new DockerSandbox({ name: a.sandbox, repo, control, logs, config, ...capabilities }),
    }, signal);
    const attempted = store.state.tasks.filter(task => run.taskIds.includes(task.id));
    log(`Run complete: ${['ready', 'skipped', 'failed', 'interrupted'].map(status => `${attempted.filter(task => task.status === status).length} ${status}`).join(', ')}; ${store.queued().filter(task => config.repositories.some(repo => repo.repo.toLowerCase() === task.issue.repo.toLowerCase())).length} queued.`);
    log(`Report: ${join(store.dir, 'runs', run.id, 'report.md')}`);
    if (run.reason || store.state.tasks.some(t => t.attempts.some(a => a.runId === run.id && ['failed', 'interrupted'].includes(a.status)))) process.exitCode = 1;
  } finally { unlock(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
