Implement the smallest production fix for the reproduced issue. Preserve the
new regression assertion and existing tests. Do not change the plan or test
commands. Run focused checks as useful; the controller independently reruns all
regression and verification commands after you finish. If the fix expands
beyond the supplied scope or limits, return blocked with the reason.
Finish any required formatting or tracked code generation before returning.
The controller rejects a final check that changes the contribution diff.
