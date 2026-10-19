# Operations

## Tune for accepted contributions

Start with two or three libraries whose tooling you know. Keep their default
priority high and remove unfamiliar targets from your local config. Once several
morning drafts are useful, widen the list or increase parallelism. Track whether
the drafts survive your review and whether manually submitted PRs are accepted;
the number of generated commits alone doesn't measure contribution quality.

Discovery ranks open unassigned issues by configured repository priority,
labels such as bug/help wanted/good first issue, and reproduction signals. It
penalizes broad proposals. This is a transparent heuristic, not a prediction of
maintainer acceptance. Before spending model tokens, the runner refetches issue
activity. A reference to any open PR conservatively skips the issue, including
references that may be tangential. Maintainer claims expressed only in prose
are evaluated by the planner from the last 25 comments. A PR without any link to
the issue may not be detected; recheck before manual publication.

`discovery.maxQueued` counts queued tasks only for the currently configured
repositories. Removing a target leaves its tasks and attempt history intact but
excludes them from discovery capacity and execution. Adding it back makes its
queued tasks eligible again; existing history still prevents duplicate work.

The starter repositories are candidates, not a statement that they all welcome
AI contributions. Planner and reviewer inspect the current upstream policy.
If a project requires prior coordination, incompatible licensing steps, or
prohibits this workflow, the task is skipped with a reason.

## First host check

The starter config uses `sandbox.command: ["sbx"]`, the standalone Docker
Sandboxes CLI. Existing local configs must select the CLI installed on the host
as well. No sandbox needs to exist beforehand: ordinary `doctor` inspects CLI
help, and the harness creates a sandbox for each task. `doctor --probe` creates
its own temporary sandbox.

Install the harness dependencies with `pnpm install --frozen-lockfile` using the
pnpm version pinned in `package.json`. Run `pnpm run build`,
`pnpm run contrib doctor`, then `pnpm run contrib doctor --probe` from the host
terminal. The probe makes a real model request and deletes its sandbox afterward.
A Codex installed in the host or in this development sandbox isn't the Codex
inside a newly created task sandbox. Its version and authentication must be
checked independently.

For `sbx`, the adapter requires create with `--name`, exec with
`--workdir`/stdin, policy deny network with `--sandbox`, and rm. The doctor detects
whether rm supports `--force`. The legacy `["docker", "sandbox"]` adapter uses
network proxy with `--block-host`; select it explicitly if that is your host CLI.
Failed help commands report their command, exit code, and diagnostic output;
they do not infer that the controller is running inside a sandbox.
Authentication differs across versions:
follow the Docker docs matching the installed CLI. The harness doesn't change
global credentials or network policy.

If `doctor` cannot find the CLI, check `sandbox.command` and the host terminal's
PATH. When running inside the current agent sandbox, run it on the host. Nested
Docker Sandboxes, a host Docker socket mount, and ordinary `docker run` fallback
are not part of this architecture.

## Diagnose a task

| Status/reason | Next step |
| --- | --- |
| `skipped`: assigned/linked PR | Choose another issue; inspect the link/context |
| `skipped`: policy/too broad/no repro | Read plan.json/reproduce.json; retry only with new information |
| setup/baseline failure | Read logs; check Node/package manager/template/network requirements |
| regression didn't fail | Reject the proposed reproduction; no ready commit is created |
| final tests failed | Inspect patch and failure; retry is explicit, with a fresh clone |
| command changed the checkout | Use check-only commands; complete formatting or tracked generation during implementation |
| review requires changes | Read review.json; implement feedback manually or retry after improving context |
| soft budget/deadline | Tune limits; the report identifies the stop reason |
| cleanup failure / stale lock | Stop old runner if still alive, then run recover |
| ready | Inspect PR.md, diff, controller logs, and current upstream activity |

All installs, build scripts, tests, lint and type checks execute in the task
sandbox. A missing tool produces a failure, not a fallback to host execution.
GitHub site/API access is blocked there. Some dependencies or test fixtures
downloaded via github.com release pages will fail; preinstall necessary tools in
a custom Codex-compatible Docker Sandbox template or choose another task. Set
`sandbox.template` to the image reference supported by the selected Docker CLI.
Use frozen dependency installs matching the target's lockfile. Broad network
tests, external RPC credentials, smart-contract edits, visual UI acceptance,
and Windows/macOS-specific validation require manual handling in this version.

The controller records the candidate diff before final verification and compares
it after every regression/check command. A successful exit code does not permit
changes to contribution files, even if a later command would restore them.
Ignored build and cache outputs remain allowed. A changed diff fails the task
before review/commit and retains the commands, logs, and patch for diagnosis.

## Morning publication

`repo/` for a ready task has a commit on the recorded local branch. `origin`
points to upstream for reads and has `disabled://local-review-only` as push URL.
After review, add your fork as a separate remote and publish with your normal
workflow. Sign/modify the commit if the project's rules require it. PR.md starts
with a title heading; use its heading as the PR title and remaining text as body.
Follow the project's automation disclosure and PR template requirements.

No comments, claims, forks, pushes, or PRs are created by this harness. There is
no PR follow-up/maintainer-reply agent yet. Morning review and subsequent review
feedback are part of the human workflow.

## Disk and scheduling

Artifacts are deliberately retained, including failed checkouts and dependency
directories written through the workspace mount. Inspect `.contributor/runs/`
periodically and delete only runs whose work you have archived. There is no
automatic retention policy that could erase an unpublished contribution.

The host resolves trusted state and checkout roots to canonical paths before
using them for Git, sandbox mounts, and new artifact paths. Parent symlinks such
as macOS `/var` are supported. The checkout's `.git` is still required to be a
local directory; replacing it with a symlink remains an error.

Generate schedule files on the host so Node's absolute path and PATH are correct.
Both launchd and cron capture the generating terminal's PATH. Cron sets it only
for the harness process, so other crontab entries keep their own environment.
Schedule generation never calls launchctl/crontab itself. launchd/cron need the
host user session, available Docker services, and authentication configured in
advance. Run `doctor --probe` after changing Docker/Codex versions or credentials.
After changing Node's installation path, regenerate/reload the schedule.
Do the same after changing the paths to Git, gh, or Docker Sandboxes.

To unload the macOS schedule:

```bash
launchctl bootout "gui/$(id -u)/local.contributor.nightly"
```

The generated Linux cron line can be added/removed with `crontab -e`. The exclusive
runner lock prevents overlapping scheduled/manual mutation commands.

`recover` writes each affected attempt's `result.json` and regenerates reports
for affected runs, including completed runs. Refreshing an older run keeps the
latest-report link on the newest run. Cleanup failures are recorded as `failed`
with `cleanupError`, return a nonzero exit status, and block `retry` until a later
recovery succeeds. Contribution patches and check logs are retained.

If the recovery process itself was killed, `.contributor/recovery.lock` contains
its PID. Check that PID is no longer running before manually removing that lock
and repeating recover. Keep one controller host per state directory; cross-host
distributed locking is not implemented.
