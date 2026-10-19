# Architecture

The host controller is a TypeScript CLI with no runtime packages. It treats
model output as a proposal; deterministic code owns state transitions and gates.

| Component | Responsibility |
| --- | --- |
| `src/github.ts` | Read-only GitHub REST calls via gh; issue, comments, timeline |
| `src/store.ts` | Atomic JSON snapshots, persistent deduplication, exclusive lock |
| `src/pipeline.ts` | Ranking, bounded scheduling, stage sequencing, quality gates |
| `src/sandbox.ts` | Native docker sandbox / sbx create, exec, network policy, rm |
| `src/git.ts` | Fresh shallow clones, host-side diff inspection and local commits |
| `src/process.ts` | argv spawning, streaming logs, output limits, process cancellation |
| `src/doctor.ts` | Host dependency/auth and CLI capability checks |
| `src/report.ts` | Run summary and links to evidence |
| `src/schedule.ts` | Generates host-specific launchd/cron artifacts |
| `prompts/` | Common instructions and four role prompts |

## Boundaries

Every attempt gets a standalone clone, containing its own `.git` directory. A
linked Git worktree would need the parent repository to resolve its `.git` file
inside Docker, so this implementation uses clones. Concurrent tasks never share
a checkout. The scheduler also prevents concurrent work on the same repository.

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
checkout and sandbox. There is no unbounded model retry or repair loop.

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
