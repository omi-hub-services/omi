# ADR-0040 — Retry authorization record

- Status: Accepted for implementation
- Date: 2026-11-13
- Issue: #237 (OMI-116)
- References: ADR-0026, ADR-0030, ADR-0037; architecture.md §9, §13; handbook §6

## Context

The quality controller already records Architect interventions and PO reopens, but an arbitrary
non-empty decision ID was sufficient to reopen a blocked run. Retry must consume a durable PO
decision, never a caller's approval flag or Issue/comment prose.

## Decision

Use an existing **business approval request** as the retry authorization record. Its `runId` must
match the blocked run, its `subjectId` must be the run's task, and its scope must cover that task.
The subject remains the current imported task baseline from ADR-0037. Create the request with
`approvals request <task-id> --kind business --run <run-id>` and decide it through
`approvals decide`. Only an approved, current, unexpired request with a recorded `po-cli`
(runtime-owned TTY) or `github-actor` (currently allowlisted actor) decision is usable. Pending,
rejected, unknown, stale, expired, wrong-run/task/kind/scope and conversation records fail closed.

The application reuses `evaluateApproval` to reject self-approval. It reads the mapped PR's author;
before a PR exists, it uses the runtime's authenticated GitHub identity, which workers share.
An unavailable author fails closed. TTY decisions retain ADR-0026's local OS identity and cooperative
human-confirmation boundary; local OS and GitHub accounts are not a new identity federation or
process isolation mechanism. Separate human/worker credentials remain necessary as in ADR-0026.
The author lookup occurs before reading current approval evidence; run version and owner lease are
checked again after that asynchronous read and before the fenced commit.

`recordReworkEvent` owns this validation for PO reopen and for an Architect solution that changes
business or cost. Public IPC `rework.record` exposes only `architect_solution_accepted`,
`architect_no_solution`, and `po_reopened`; it cannot submit internal cycle/gate events or
`approvalValid`. `rework record` is the thin CLI equivalent. Architect solutions that change
business or cost require `--po-decision`; validity is derived by the runtime.

A successful reopen commits the run transition and the decision ID in the existing rework history
atomically. An already consumed reopen ID cannot authorize another reopen. An explicit PO reopen
uses the existing domain transition to begin a new quality segment while retaining all counted
cycle IDs and reopen decisions. An ordinary retry never resets the 2 + Architect + 2 controller.

`retry --run --step [--po-decision]` redispatches an automatically readied failed step, readies a
failed step only when live rework state allows it, and re-enters `failoverStep` for resource waits.
It refuses Architect escalation, inactive runs, steps without a failed/interrupted attempt and
spent operational budget. Terminal attempts are immutable: dispatch always allocates a new one.
Operational failures are counted durably from step events, separately from quality outcomes;
changing profile/model, reopening, or rerunning the command does not erase them.

## Consequences

No dependency, module, migration, approval kind or alternative decision pathway is added. The v1
command schema is extended and regenerated. Current task approval is reused only when explicitly
bound to this run; an ordinary task approval without `runId` cannot reopen it. A task baseline
change requires re-import and a fresh approval. Review and merge approval gates are unchanged.
