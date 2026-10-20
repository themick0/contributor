Repair the current implementation using the controller's failure feedback.
Read the referenced check logs, current change.patch, and any reviewer findings
in controlDirectory. Address the reported cause with a focused change, then return
done or blocked with an English summary. This is a fresh session in the existing
task sandbox; the baseline and failing regression have already been recorded.

Preserve every file recorded in regression.patch byte-for-byte. Do not weaken,
delete or bypass tests, modify the approved commands or contribution policy, or
change Git metadata. Fix production code and permissible supporting files within
the original issue scope and diff limits. If the feedback requires changing the
protected regression or an unapproved behavior change, return blocked and explain
why. Do not invent a different task to obtain a passing check.

The host will rerun the same regression and verification commands and obtain a
fresh independent review. Do not claim that a previous approval or a locally run
command replaces those gates. No publication or GitHub writes are authorized.
