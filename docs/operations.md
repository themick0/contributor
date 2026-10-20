# Operations

## Tune for accepted contributions

Pin libraries whose tooling you know and keep their priority high. Use the
repository scout to find additional libraries matching your criteria. Exclude
unwanted targets or disable scouting for a fixed list. Once several morning
drafts are useful, widen the criteria or increase parallelism. Track whether
the drafts survive your review and whether manually submitted PRs are accepted;
the number of generated commits alone doesn't measure contribution quality.

Discovery ranks open unassigned issues by configured repository priority,
labels such as bug/help wanted/good first issue, concrete reproduction hints,
and recent activity. Code examples and reproduction links add weight; empty
template headings such as "Expected behavior" do not. Old activity and feature
proposals receive lower scores. This is a transparent heuristic, not a prediction
of maintainer acceptance. Discovery screens current issue activity before enqueue,
and the runner refetches it before spending model tokens. A reference to any open
PR conservatively skips the issue, including
references that may be tangential. Maintainer claims expressed only in prose
are evaluated by the planner from the last 25 comments. A PR without any link to
the issue may not be detected; recheck before manual publication.

`limits.maxTasks` and `limits.maxTasksPerRepo` count work attempts and failures,
excluding definitive GitHub eligibility skips and clean planner declines. When
an issue is closed, assigned, excluded by label, or linked to an open PR, the runner records
the skip and selects a replacement from the queue. Another issue from the same
repository can use the released slot. A planner decline also releases the slot
after cleanup; its reported tokens and elapsed time still count. Reproduction
skips and clone, API, sandbox, cleanup, or verification failures consume a work
attempt. Final checks and actionable reviewer findings can trigger a repair
within that attempt, as described below. Completed failed attempts still require
explicit retry. Concurrency, deadlines, token limits, and persistent GitHub
throttling stop new work. After processing available queued work, `night` refills
the queue for repositories with remaining work slots. All rounds share the same
run ID, attempt counters, token total, and deadline.
Use `pnpm run contrib run` to process remaining queued issues without another
discovery scan.

Discovery uses `discovery.issuesPerRepo` as the page size (30 by default), with
`maxPagesPerRepo: 3` and `maxCandidateChecks: 60` as independent scan bounds.
`maxRoundsPerNight: 12` bounds scans in a single night (allowed range 1–100). Older
local configs receive the same new defaults. It pages further when the first
page contains known history or unsuitable candidates, and initially reserves
screening opportunities for each repository. A full active queue avoids another
scan. Definitive discovery rejections are saved as `skipped` with a reason and
zero attempts; they do not occupy queue slots. Transient API failures do not
permanently reject an issue. Accepted candidates and definitive rejections are
saved before moving on, so later cancellation or throttling preserves those decisions.

Queued issues seen again during a scan receive refreshed metadata and scores.
Existing equal scores are ordered by latest issue activity, so a recent bug is
not left behind a years-old issue merely because its repository was scanned
later. Within a night, buffered candidates and per-repository page positions
survive refills. Each new invocation starts at page one and skips known IDs;
page cursors are not persisted across processes. Refills stop at exhausted results,
the 1,000-result GitHub search boundary, queue capacity, or configured limits.
The report records the number of discovery rounds and their stop reason.

`discovery.maxQueued` counts queued tasks in the invocation's active target set.
During `night`, that includes retained backlog as well as pinned and currently
recommended repositories. A standalone `discover` scans only pinned and currently
recommended targets. Catalog rotation preserves accepted backlog for execution,
but does not start new searches in those retained repositories. Tasks outside the
active set remain saved. Existing history prevents duplicate work.

The starter repositories are candidates, not a statement that they all welcome
AI contributions. Planner and reviewer inspect the current upstream policy.
If a project requires prior coordination, incompatible licensing steps, or
prohibits this workflow, the task is skipped with a reason.

## AI repository discovery

Repository discovery and issue discovery are separate stages. Repository scouting
uses AI to design GitHub search queries and assess verified projects. Issue search
still uses deterministic ranking and live context checks; the task planner makes
the deeper model assessment after cloning a selected repository.

```bash
pnpm run contrib scout --dry-run  # Offline settings and active targets
pnpm run contrib scout            # Force a real repository refresh
pnpm run contrib discover         # Find issues in pinned and catalog targets
pnpm run night                    # Refresh scout if due, discover issues, run work
```

Configure `repositoryDiscovery` in your config:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Automatic scouting in night; false also ignores the catalog |
| `criteria` | Established DeFi/frontend/TS/Node libraries and utilities | English selection criteria supplied to both sessions |
| `areas` | `defi`, `frontend`, `typescript`, `node` | Areas used for queries and classification; 1–8 unique slugs |
| `excludeRepositories` | `[]` | Case-insensitive owner/repo exclusions; remove from pinned list first |
| `minStars` | `1000` | Popularity threshold checked against live metadata |
| `maxInactiveDays` | `180` | Maximum time since the latest push |
| `maxQueries` | `6` | Maximum AI-generated search queries; at most 12 |
| `resultsPerQuery` | `10` | Top results by stars per query; at most 100 |
| `maxCandidates` | `12` | Maximum detailed repository checks; at most 50 |
| `maxRepositories` | `6` | Maximum active recommendations; no larger than maxCandidates |
| `issuesPerPage` | `20` | Issue search page size for repository evidence; at most 100 |
| `maxIssuePages` | `3` | Maximum issue pages per candidate repository; at most 10 |
| `issueSamples` | `5` | Best eligible issues supplied to the selection model; at most 10 and no larger than the search window |
| `refreshHours` | `24` | Cache age that triggers automatic refresh |
| `minutes` | `30` | Scout deadline, also bounded by the remaining night deadline |
| `softTokenBudget` | `200000` | Stops new scout stages; also bounded by the night budget |

Older configs receive these defaults, including enabled scouting. Set
`repositoryDiscovery.enabled: false` to keep a fixed list. A standalone `scout`
requires scouting to be enabled. Dry runs perform no GitHub or model calls.

The first fresh session returns bounded GitHub repository queries. The host adds
star/activity/public-project filters, deduplicates the results and inspects them
round-robin across queries. It checks current metadata and language mix, then
fetches bounded excerpts of README, root and .github CONTRIBUTING.md, AGENTS.md,
package.json and five recent closed PRs. For issue evidence it scans up to three
pages of 20 open unassigned issues, filters excluded candidates, and ranks by
labels, reproduction hints and activity. It stops early after finding five
candidates meeting the issue score threshold or reaching the final page, and
passes the best five eligible samples to the model. `issue_sampling` in the
evidence records the inspected count and page bounds. These configurable bounds
can still leave suitable older issues undiscovered.
Forks, archived/disabled/private repositories, projects without JS/TS code, and
projects without eligible issues in the sample are excluded before model selection.

The second fresh session assesses library relevance, practical opportunities,
maintainer activity and policy from these sources. Every selection needs a reason
and verifiable quotes from library documentation and an issue sample. Unknown repo
IDs, invented sources/quotes, incomplete assessments and selections marked as
prohibited, permission-required or unclear are rejected. The model interprets
source meaning; matching a quote mechanically does not prove its conclusion.
`unspecified` policy means no relevant restriction was identified in the fetched
sources, not approval. The task planner checks the full checkout policy again.
These small samples cannot establish an acceptance rate, prove an issue is still
available, or cover all repository policies. Linked-PR checks happen during issue
discovery and again before work begins.

`.contributor/repositories.json` stores the most recent successful recommendations
and `retainedRepositories` for accepted backlog, separately from pinned config.
`discover` and `enqueue` use pins and current recommendations. `night`, `run`, and
offline previews also include retained repositories with queued tasks. A successful
refresh, even an empty selection, preserves backlog from the previous compatible
catalog. Failed/interrupted work retains its repository entry for later explicit
retry, but is not automatically requeued. A later successful refresh drops entries
with no remaining backlog. Every task still receives fresh issue preflight and
checkout policy checks; retained entries do not imply a new metadata assessment.
Pin a recommendation to keep searching it permanently. Removing a pin can allow
rediscovery unless it is added to exclusions. Changing scout settings or pinned
targets invalidates the catalog, including retained entries; disabling scouting
also disables them. Task history remains saved. Changing settings back can reuse
a compatible saved catalog.

`night` uses a fresh catalog without model requests. When a refresh fails after
startup, it retains the previous compatible catalog, even if older than the refresh
interval, and continues with available targets. `discover`/`run` use that same
catalog without triggering refresh. If no compatible catalog exists, they use
pinned targets. Cancellation, exhausted GitHub retries and the overall night budget
still stop new work. A cleanup failure or unfinished scout requires `recover`.
Explicit `scout` returns a nonzero exit code on failure. Failed issue discovery in
`night` records the error in the run report while allowing saved work to proceed
when GitHub and the run limits still permit it.

Scouting uses the existing sbx adapter and scoped network policy. Only a scratch
Git repo and read-only evidence directory are mounted; GitHub GETs and credentials
stay on the host. No upstream code is executed during scouting. The catalog is
activated only after output validation and successful sandbox removal. Scout
history is persisted before sandbox creation, and `recover` can clean orphan
scout sandboxes. Recovery never activates an interrupted selection.

Inspect `.contributor/scouts/<id>/report.md`, `result.json`, `searches.json`,
`screening.json`, `control/evidence.json`, and `logs/`. The night report links its
scout report, and its token total includes new scout stages, including failed
ones with reported usage. Cached stages are not charged again. Standalone scout
usage is recorded in its own report. As with task stages, interrupted sessions
may report no tokens; completed responses can exceed a soft budget.

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
| final tests failed | Inspect numbered check logs and repair feedback; after repair exhaustion, retry is explicit with a fresh clone |
| command changed the checkout | Use check-only commands; complete formatting or tracked generation during implementation |
| review requires changes | Read review.json, numbered reviews, and repair feedback; policy/regression rejection is terminal |
| soft budget/deadline | Tune limits; the report identifies the stop reason |
| cleanup failure / stale lock | Stop old runner if still alive, then run recover |
| ready | Inspect PR.md, diff, controller logs, and current upstream activity |

## GitHub request handling

Preflight, discovery, and issue context use one serial API request queue per
controller process. Request starts are spaced by at least one second; search
requests are spaced by at least three seconds. Pagination follows GitHub's
`Link` headers through the same queue, so a failed page is retried individually.

HTTP 429 and rate-limit responses with HTTP 403 pause requests. The controller
honors `Retry-After` and, when the primary quota is exhausted, `X-RateLimit-Reset`.
Server time is used when available to account for host clock skew. Without a
usable header, the first wait is one minute. Subsequent waits grow exponentially;
each request gets at most five retries. With no headers, the waits are 1, 2, 4,
8, and 16 minutes. Temporary connection errors, request timeouts, and HTTP 5xx
responses get up to five retries starting at five seconds. Authentication,
permission, and not-found errors fail immediately.

The next allowed request time is stored in `.contributor/github-cooldown.json`.
Restarting the controller preserves this wait. Retry messages are printed to
stderr. `Ctrl+C`, `SIGTERM`, and task/run deadlines interrupt waits, including a
task waiting behind another task's request. Keep one active controller per state
directory; this queue does not coordinate other tools using the same account.

If rate-limit retries are exhausted, the client stops issuing requests for the
rest of that invocation. Discovery retains saved queue/history updates. During a
run, started attempts record their outcome and remaining tasks stay queued. Work
that has already passed its GitHub checks can finish normally.
After the cooldown, resume queued work with `pnpm run contrib run`. A started
attempt that failed still requires an explicit `retry`.

This follows GitHub's [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately).

## Sandbox execution checks

`limits.maxRepairAttempts` defaults to 2, accepts 0–5, and bounds repair sessions
after final regression/check failures or actionable reviewer findings. Set it to
0 for immediate failure. Repairs stay in the same attempt and checkout, consume
the same night tokens, and keep the original task deadline. Each uses a fresh
Codex session with the failed command logs or reviewer findings, approved plan,
and list of protected regression files. It cannot change the original regression
files, approved commands, scope, policy, or Git metadata.

Every repaired patch reruns all final regression and verification commands, then
gets a fresh independent review. The baseline and original red regression evidence
are preserved. Setup/baseline failures, invalid reproductions, policy rejection,
check/reviewer mutations, and blocked repairs terminate the attempt. Failed checks
and earlier reviews remain archived under distinct names (`repair-1`,
`regression-after-repair-1`, `verification-repair-1`, `review-repair-1`). Reviewers
receive the names of the current validation phases as well as earlier evidence.
`control/candidate.patch` and `control/candidate-repair-N.patch` preserve the
exact diff evaluated in each round; `control/change.patch` holds the latest one.

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
