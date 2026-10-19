# Contributor harness

Build useful, reproducible contributions to established TypeScript/JavaScript
libraries. The owner reviews local branches and PR drafts before publication.
Optimize for useful fixes that maintainers can accept, with concrete evidence.

## Language

All authored repository content must be in English, including documentation,
code comments, identifiers, CLI messages, agent prompts, test descriptions, and
configuration descriptions. Generated reports, commit messages, and PR titles
and descriptions must also be in English. Apply this rule regardless of the
language used in the conversation or the source issue.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## Architecture and invariants

- The controller runs on the user's host, outside Docker Sandboxes. It owns
  GitHub reads, queue, Git operations, limits, logs, and reports.
- The user's host uses the standalone `sbx` CLI. Keep it selected in the starter
  config and command examples; the legacy `docker sandbox` adapter is optional.
- Codex and ALL upstream installs/builds/tests run inside a task's Docker Sandbox.
  Never fall back to running upstream commands on the host when Docker is absent.
- Use argument arrays for subprocesses. Send prompts over stdin. Never interpolate
  issue content or model commands into a host shell.
- Mount only a task's standalone clone and its read-only control directory.
  Never mount the controller repo, state directory, home, or Docker socket.
- Keep the mode local: no GitHub comments, pushes, forks, PR creation, or package
  publication. This is the user's chosen workflow.
- Retain the baseline pass → meaningful regression failure → final pass → fresh
  reviewer approval sequence. Gate on actual process exit codes and diffs.
- A cleanup failure must not be reported as ready. A crashed attempt requires
  explicit recovery/retry; it must never silently count as completed.
- Follow upstream contribution/automation policies. Skip unsuitable tasks with
  a reason. Never manufacture tests or change behavior to create activity.
- The token budget is soft and based on reported usage, not a dollar ceiling.

## Development

Use pnpm for this harness; its version is pinned in `package.json`.
Install dependencies with `pnpm install --frozen-lockfile`.
Upstream repositories retain their own package managers and lockfiles.

TypeScript, Node.js 22+, no runtime dependencies. `pnpm test` compiles and runs
unit/integration tests using local fixtures; it needs no model or GitHub token.
Use `pnpm run check` for type checking. `pnpm run contrib run --dry-run` is offline.
`doctor --probe` creates a real sandbox and makes a model request; run it on the
host when checking the actual Docker/Codex integration.

CLI/config changes need corresponding README/operations updates. Preserve the
user's selected Docker Sandbox CLI; do not silently substitute ordinary Docker
containers. Check current official docs before changing CLI flags or auth setup.
