# ADR-0034 — Task PR merge gates, native approval and state read-back operations

- Status: Accepted
- Date: 2026-11-11
- Issue: #27 (OMI-023), epic #22, milestone M3 — Task delivery
- Context: architecture.md §11 ("PR vào develop", "Agent review và GitHub approval");
  design-patterns.md §3, §7, §8; ADR-0014 (the Coordinator's own merge/close gates, the reference
  rules); ADR-0017 (domain policies); ADR-0025 (outbox, marker, reconciliation); ADR-0026
  (approval lifecycle)

## Context

`evaluateMerge` and the merge state machine existed since ADR-0017, but nothing merged a task PR.
The Coordinator dev tooling (`tools/coordinator/`, ADR-0014) already enforces the rules for this
repository: a PASS on the exact head, one `AC-<n>: met|not met — <evidence>` line per top-level
criterion, ticking the criteria from those lines when the Issue is closed. The product needs the
same rules behind ports, with the outbox's crash safety, and without faking native approval.

## Decision

1. **Gates are domain policy** (`domain/delivery/merge-policy.ts`):
   - `evaluateMerge` adds: the PR head equals the reviewed SHA the merge is asked for
     (`HEAD_MOVED`); the reviewer differs from every implementing run **and** agent (blank
     identities refuse); the review's `AC-<n>` lines (`domain/delivery/acceptance-review.ts`) are
     exactly one well-formed `met` line per criterion counted by `acceptanceCriteria` (OMI-022's
     top-level rule); GitHub's `mergeable_state` must be `clean` or `has_hooks`, as in ADR-0014;
     native approval (point 3).
   - `evaluateMergeConfirmation`: a merge counts only when a fresh read shows the PR merged into
     `develop` at the reviewed head, and a merge commit with that head as a parent is reachable
     from `develop`.
   - `evaluateIssueClose`: criteria are ticked and the Issue closed only from an independent PASS
     on the merged head with a `met` line for every criterion. The base may have moved by then.
   - `tickAcceptanceCriteria` (`domain/tasks/acceptance-criteria.ts`) changes only `[ ]` to `[x]`
     on criterion lines, byte for byte otherwise, with the same line rule as `acceptanceCriteria`.
2. **Use case** `application/use-cases/delivery/merge-task-pr.ts`: verify the PR mapping from
   `preparePr`, read back earlier attempts, take the merge lock (`LeaseStore`, key
   `merge-queue:<repo>:develop`, one merge at a time per base), re-read PR, base head, rulesets,
   checks, native reviews, Issue and review evidence under the lock, decide, merge through the
   outbox, release the lock, confirm from the remote, then tick, close and record Done. The
   independent review is local evidence (`MergeEvidenceReader`: the review step's recorded result
   for one head, plus implementing runs/agents and workflow gates), never text in the PR.
3. **Native approval is read, never produced.** The required count is the higher of the base
   branch's ruleset (`GET /repos/{repo}/rules/branches/develop`, readable without admin rights)
   and the project's minimum. An approval counts only on the current head, from a `User` who is
   neither the PR author nor the account the runtime's credential acts as (`GET /user`); the
   latest decisive review per reviewer counts, and outstanding requested changes refuse. The
   runtime never submits a review, and the merge call never asks to bypass protection; GitHub's
   own refusal (405) is reported as `MERGE_REJECTED`.
4. **State operations in the outbox** (`contracts/github-operation.ts`,
   `infrastructure/github/github-state-operations.ts`): `pull_request.merge` (merge commit, `sha`
   head-match guard), `issue.update_body` (`fromBody` → `body`), `issue.close`. They change an
   existing object, so no marker is written: a merge has no body, and the Issue body may change
   only in its Acceptance criteria section. Their read-back is the remote state — merged at the
   expected head, body equal to the target, Issue closed — found at any time, absent only after
   the grace period, as in ADR-0025. GitHub has no conditional Issue update, so the adapter reads
   the body right before the write and refuses `ISSUE_BODY_CHANGED` when it is neither the
   expected nor the target body. Operation keys name the PR or Issue and the reviewed head.
5. `HttpMethod` gains `PUT` and `PATCH`; `writeOutcome` in `github-rest-client.ts` is the one
   mapping of a write answer to an outbox outcome, shared by `github-remote.ts`.

## Consequences

- A retry after any crash reads back first: the merge, tick and close are each sent at most once
  per key unless GitHub showed they did not happen (covered by `tests/e2e/merge-task-pr.test.ts`).
- A carried PASS over a clean sync with `develop` (ADR-0014, OMI-069) is **not** implemented: the
  product has no git read of merge parents/trees yet. A sync changes the head, so the merge is
  refused until a review is recorded on the new head. This is stricter than the Coordinator,
  never weaker.
- A GitHub refusal of the merge after every local gate passed leaves the outbox row `failed`;
  merging that head again needs the outbox's recorded reopen decision (ADR-0025).
- The use case sends a merge only right after the gates passed under the lock. A merge row that
  went back to `pending` (rate limit, or absent after the grace period) is re-gated by the next
  `mergeTaskPr` call, but a general outbox flush (the future `omi sync`) would send it without
  re-evaluating the gates; only the head guard and GitHub's own rules apply then. Excluding
  `pull_request.merge` from a general flush is left to the `omi sync` task.
- There is a short window between the adapter's body read and the PATCH in which another edit can
  be overwritten; GitHub offers no compare-and-swap on Issue bodies.
- Persistence for `MergeEvidenceReader` and `TaskCompletionStore` and the Project Status field
  update (OMI-019) are not part of this decision; tests use in-memory implementations, and
  bootstrap wiring follows with the CLI.
- No new dependency, layer, module or guard exception.
