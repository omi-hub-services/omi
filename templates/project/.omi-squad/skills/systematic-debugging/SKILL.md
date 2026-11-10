---
name: systematic-debugging
description: Use for any bug, test failure, build failure or unexpected behaviour, before proposing a fix. Find the root cause first; fix once; escalate after repeated failed fixes.
---

# Systematic debugging

Adapted from Superpowers `systematic-debugging` (MIT, Jesse Vincent). See `../NOTICE.md`.

Find the root cause before attempting a fix. Fixing a symptom is a failure, not progress.

```
No fix without a root-cause investigation first.
```

Use it for every technical issue, and especially under time pressure, when a fix looks obvious, or
when an earlier fix did not work.

## Phase 1: Root-cause investigation

1. **Read the errors completely**: messages, stack traces, line numbers, codes.
2. **Reproduce** reliably with exact steps. If you cannot, gather more data; do not guess.
3. **Check what changed**: the diff, recent commits, dependency or configuration changes, the
   environment.
4. **Instrument component boundaries** when several components are involved: record what enters and
   leaves each one, run once, and find the boundary where the data goes wrong. Do not log secrets,
   tokens or credentials.
5. **Trace the data flow backwards** from the bad value to its origin, and fix at the source, not at
   the symptom.

## Phase 2: Pattern analysis

Find similar working code in the same codebase, read the reference implementation completely, list
every difference between working and broken (however small), and note the assumptions and
dependencies involved.

## Phase 3: Hypothesis

State one hypothesis: "I think X is the root cause because Y". Test it with the smallest possible
change, one variable at a time. If it fails, form a new hypothesis; do not stack fixes on top. When
you do not know, say "I do not understand X" and research further.

## Phase 4: Fix

1. Write a failing test that reproduces the bug (see `test-driven-development`).
2. Make a single fix for the root cause. No bundled refactoring, no "while I am here" changes.
3. Verify: the test passes, the suite passes, the original symptom is gone (see
   `verification-before-completion`).
4. If the fix did not work, count your attempts. Fewer than three: return to phase 1 with the new
   information. Three or more: stop. The pattern probably points at an architectural problem.
   Report to the Coordinator what each attempt revealed and ask for a decision before attempting
   another fix. Do not change the workflow, the scope or the architecture yourself.

## Red flags: stop and return to phase 1

- "Quick fix now, investigate later."
- "Just try changing X and see."
- Several changes at once, then one test run.
- "I do not fully understand this, but it might work."
- "One more attempt", when you have already tried twice.
- Each fix reveals a new problem somewhere else.

## When there is no root cause

If the investigation shows the cause is environmental, timing-dependent or external, document what
you checked, add appropriate handling (retry, timeout, a clear error message) and logging, and
report it as such. Most "no root cause" cases are incomplete investigations, so check again first.
