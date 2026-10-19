Inspect this issue and checkout. Do not edit files. Decide whether a narrow,
testable fix is appropriate. Read recent issue comments and contribution rules.
When declining, return decision=skip with a concrete reason.

When implementing, produce a plan with commands as argv arrays and cwd relative
to the repository root (use "." for the root). Commands run directly, without a
host shell. A shell command is allowed only as ["bash", "-lc", "..."] inside
the sandbox when the project actually requires shell composition.

setup: frozen dependency install and necessary bootstrap/build commands.
regression: focused commands that pass on the current checkout, fail once the
reproducer adds a regression test, and pass after the fix. Choose a test file or
suite that already exists, so the baseline can run before the new test is added.
checks: required lint/type/test commands relevant to the change, read from the
repository docs and CI. Both regression and checks must be nonempty.
Choose check-only modes rather than lint autofix or snapshot updates. After the
implementation, every regression/check command must preserve the contribution
diff. Put required generation or formatting in the implementation instructions;
ignored build/cache output is allowed during checks.

The controller runs setup and ALL baseline commands before editing. A failing
baseline blocks the task. Keep the total cost within the supplied limits.
Describe which contribution policies you found, with file paths, and how this
task meets them. Do not infer that an absent AI policy is an explicit approval.
