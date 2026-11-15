---
name: verification-before-completion
description: Use before claiming that work is complete, fixed or passing. Run the verification commands and read their output before stating any result.
---

# Verification before completion

Adapted from Superpowers `verification-before-completion` (MIT, Jesse Vincent). See `../NOTICE.md`.

Evidence before claims. If you have not run the verification command in this step, you cannot claim
that it passes. Your report is evidence for the Coordinator, the reviewer and the PO; a claim
without a fresh run is a defect in the report.

## The gate

Before stating any status:

1. **Identify** the command that proves the claim (the project's check, test or build command, or
   the one the task names).
2. **Run** the full command, fresh and complete.
3. **Read** the whole output, check the exit code, count the failures.
4. **Compare** the output with the claim. If it does not confirm the claim, state the actual status
   with the evidence.
5. **Then** make the claim, and quote the evidence (command, result line).

## What counts

| Claim                 | Requires                                             | Not enough                     |
| --------------------- | ---------------------------------------------------- | ------------------------------ |
| Tests pass            | Test command output with 0 failures                  | An earlier run, "should pass"  |
| Lint is clean         | Lint output with 0 errors                            | A partial check                |
| Build succeeds        | Build command with exit 0                            | Lint passing                   |
| Bug fixed             | The original symptom reproduced, then passing        | "Code changed, so it is fixed" |
| Regression test works | Red-green cycle seen                                 | A single passing run           |
| Requirements met      | A line-by-line check against the acceptance criteria | Tests passing                  |

## Report faithfully

- A check you did not run, or could not run, is reported as not run, with the reason. Never report
  a skipped check as passed.
- A failing check is reported with its output. Never loosen a check, rule, test or gate to make a
  result pass.
- State what you could not verify (a live service, another platform, a visual result).
- Output from another agent or tool is a claim, not evidence. Check the actual workspace state
  (the diff, the files) before repeating it.

## Red flags

- Words such as "should", "probably", "seems to".
- Expressing satisfaction before verification ("Done!", "Perfect!").
- Trusting a success message from a tool or another agent.
- Relying on partial verification, or "just this once".

Each of these means: stop, run the verification, then report.
