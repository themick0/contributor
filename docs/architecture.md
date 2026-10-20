# Architecture

The host controller is a TypeScript CLI with no runtime packages. It treats
model output as a proposal; deterministic code owns state transitions and gates.

| Component | Responsibility |
| --- | --- |
| `src/github.ts` | Repository search, issue context, and pagination via GitHub REST |
| `src/github-api.ts` | Serial GET queue via gh, pacing, bounded retries, persistent cooldown |
| `src/store.ts` | Atomic JSON snapshots, persistent deduplication, exclusive lock |
| `src/discovery.ts` | Bounded paginated discovery, repository diversity, candidate screening |
| `src/scout.ts` | AI query planning and repository assessment, evidence collection, tracked sandbox lifecycle |
| `src/repositories.ts` | Catalog validation/cache, pinned target merge, model output and citation validation |
| `src/pipeline.ts` | Bounded scheduling, stage sequencing, quality gates |
| `src/sandbox.ts` | Native docker sandbox / sbx create, exec, network policy, rm |
| `src/git.ts` | Fresh shallow clones, host-side diff inspection and local commits |
| `src/process.ts` | argv spawning, streaming logs, output limits, process cancellation |
| `src/doctor.ts` | Host dependency/auth and CLI capability checks |
| `src/report.ts` | Run summary and links to evidence |
| `src/schedule.ts` | Generates host-specific launchd/cron artifacts |
| `prompts/` | Task instructions and role prompts; separate repository scout prompts |

## Boundaries

Repository scouting runs before issue discovery when enabled and due. A fresh
Codex session proposes GitHub queries. The host adds threshold filters, fetches
and verifies facts, then supplies bounded source excerpts to a second fresh
session. The host validates candidate identity, model classifications, selection
limits and quote provenance before publishing a separate catalog. Semantic
relevance and policy interpretation remain model judgments, rechecked at task
planning. Pinned config is never rewritten. Compatible successful catalogs are
cached; failed refreshes preserve them. Catalogs are replaced only after sandbox
cleanup, and orphan scouts participate in explicit recovery. New scout stage
usage counts toward the enclosing night budget.
Successful catalog rotation retains repositories with accepted pending or failed
work from the previous compatible catalog. Only queued tasks activate those
entries for execution; new discovery uses pins and current recommendations.
Issue evidence is a bounded paginated search (20 × 3 by default), reduced to the
five highest-ranked eligible samples for the selection session.

The scout sandbox mounts an isolated scratch Git repository and its read-only
control directory. It never mounts the catalog or state snapshot. All GitHub
research uses the controller's existing serial GET queue and persistent cooldown.
It runs no upstream installs or verification commands.

Every attempt that passes GitHub preflight gets a standalone clone, containing
its own `.git` directory. A linked Git worktree would need the parent repository
to resolve its `.git` file inside Docker, so this implementation uses clones.
Concurrent tasks never share a checkout. The scheduler also prevents concurrent
work on the same repository.
GitHub preflight skips are recorded without cloning or starting a sandbox.

Workers select candidates from the configured repositories' ranked queue as
slots become available. Global and per-repository attempt slots are reserved
before preflight; a closed, assigned, excluded, or PR-linked issue releases both
slots so its worker can take the next candidate. A planner declining an unchanged
checkout also releases both slots once sandbox cleanup succeeds. Its token usage
remains charged. Errors, cleanup failures, and attempts that pass planning keep
their slots. This bounds actual work without ending a run after its first
few candidates prove ineligible. Unstarted candidates remain queued.
`night` alternates workers with bounded queue refills under one run, token total,
deadline, and set of quotas. A shared discovery session retains page positions,
seen IDs, and unused candidates across rounds. Repositories with exhausted work
slots receive no further discovery requests. `run` only consumes saved tasks.

Discovery pages past known history, screens current issue context before enqueue,
and records each definitive rejection or accepted candidate immediately. Initial screening
slots are shared across configured repositories; remaining capacity favors
repositories with fewer queued tasks. Search pages and candidate checks have
separate bounds. Queued snapshots encountered during discovery are refreshed;
completed/skipped history is never silently retried. New ranking rewards code
examples, reproduction links, and recent activity. Equal scores in an existing
queue are ordered by issue activity before insertion time. Runtime preflight
still refetches context because eligibility can change after discovery.

Only the clone and a read-only control directory are mounted. The queue, other
checkouts, host home, and controller code remain outside those mounts. Before
starting the sandbox, the controller copies Git metadata into an unmounted
`git-host/` directory. All host Git commands use that trusted metadata with the
task checkout as worktree. This prevents a sandbox-authored Git filter/hook/config
from executing on the host. Source config/HEAD/ref changes are also rejected.
After sandbox deletion and commit, trusted metadata is copied back to `repo/.git`
so the local branch is usable normally. Host Git operations additionally disable
hooks, fsmonitor, external diff/text conversion, and global Git configuration. Upstream
commands from the model are always argv sent to sandbox exec.

Codex uses `exec --json --output-schema ...` and a prompt on stdin. Each role
starts a new session. The host parses the final structured response and validates
required fields. Raw events and stderr are separate logs. No model-selected
shell string is executed on the host. A shell requested by the planner can only
run as a sandbox command.

Model credentials use Docker's existing authentication mechanism; the harness
does not copy auth files or tokens into workspaces. GitHub calls happen on the
host. The sandbox CLI environment omits GitHub/API token variables and SSH agent
socket variables. Stored Docker secrets and daemon configuration are managed by
Docker itself. Per-sandbox blocks on GitHub's API/site/SSH destinations enforce
the selected local preparation workflow; raw/codeload content isn't blocked.

## Acceptance sequence

1. Refetch issue, comments, all timeline pages. Skip closed/assigned/excluded
   issues and known references from open PRs.
2. Clone current default branch, record SHA, create task branch.
3. Create sandbox, apply network policy, verify Codex output flags.
4. Planner inspects repository policy and returns setup/regression/check commands.
   Any tracked or unignored edit during planning fails the gate.
5. Install/bootstrap; run baseline regression and verification commands. Require
   all commands to pass and the tracked/unignored checkout to remain clean.
6. Reproducer adds tests/fixtures only. Capture patch and hashes. Require a
   focused regression command to fail; the reviewer later checks why it failed.
7. Implementer fixes production code. Regression file hashes must stay unchanged.
8. Host runs the same regression commands and required verification commands in
   the sandbox. Every command must exit zero; the test hashes must still match.
9. A fresh reviewer sees actual diffs and controller-owned logs. Require approval,
   meaningful regression, policy compliance, no findings, and a usable PR draft.
   The checkout must remain identical during review.
   Failed final checks or implementation findings may trigger a bounded repair
   session and a repeat of steps 8–9. The original regression hashes, approved
   commands, task deadline, and shared token total remain in force. Policy or
   regression rejection and checkout mutations cannot trigger repairs.
10. Delete sandbox. Recheck HEAD and diff after shutdown. Only then commit on the
    host, export patch and PR.md, and mark ready.

Empty/oversized/binary/symlink diffs, Solidity changes, workflow changes, selected
credential paths, and Git history changes fail the gate. This is scoped to
JavaScript/TypeScript bug fixes. Repository policy and semantic correctness are
judged by the model reviewer and ultimately by the human, not by these mechanical
checks alone.

## Failure semantics

Queue identity is case-insensitive `owner/repo#issue`. Completed and skipped
tasks remain in history. Only explicit retry requeues one. Each attempt has a new
checkout and sandbox. A failed attempt is never automatically requeued. Repairs
within an attempt default to two rounds and terminate on their cap or any
task/run limit. Every round keeps separate model output, feedback, and check logs;
fresh review receives the current passing phases and archived earlier failures.

Mutation commands hold `runner.lock`; readonly commands read atomic snapshots.
Timeouts/SIGTERM stop the host process group. Because killing an exec client
doesn't prove remote commands have stopped, the pipeline then removes the named
sandbox. Failure to remove it is recorded and prevents ready/retry until recovery.
Recovery refuses a live owner PID and only removes recorded `contrib-*` sandboxes.

The whole run, each task, each agent session, and each validation command have
deadlines. Cleanup is attempted separately even after cancellation. Completed
stage usage is accumulated across workers. The token limit is deliberately soft:
in-flight sessions can overshoot, and interrupted sessions may report no usage.
Exact billing belongs to the model provider.
