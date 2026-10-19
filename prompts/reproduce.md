Add a regression test for the supplied plan, following the existing test style.
Modify tests/fixtures only at this stage. Do not modify production behavior.
The controller has already verified the baseline passes. The SAME regression
commands must now fail because of the issue's behavior, with a clear expected
versus actual result. A missing tool, import error, timeout, or test runner error
is not a valid reproduction. Run the focused test to confirm this if needed.
If the issue cannot be reproduced, return blocked and explain why.
