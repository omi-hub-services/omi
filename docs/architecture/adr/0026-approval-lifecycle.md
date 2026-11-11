# ADR-0026 — Versioned approval requests and authenticated decision pathways

- Status: Accepted
- Date: 2026-11-11
- Issue: #34 (OMI-029)
- References: ADR-0016, ADR-0017, ADR-0018, ADR-0020, ADR-0022;
  architecture.md §8, §11; design-patterns.md §10

## Decision

Extend the existing approval domain and state machine. A request has an ID, subject ID,
revision hash, full typed subject/scope, monotonically increasing version and lifecycle status.
Cost subjects pin an estimate hash and scope IDs alongside the existing business/release/deploy
subjects. `invalidated` remains the existing state-machine vocabulary for a stale subject;
`STALE_REVISION` reports the refusal. A terminal request cannot be revived: a changed subject
needs a distinct request. Repeated unchanged execution checks do not request another approval.

The application obtains the subject from an authoritative reader supplied by the workflow.
It does not accept the baseline/hash from a worker command. Request/decision inputs are strict,
versioned contracts. Worker result JSON remains a claim and rejects approval fields.

An `ApprovalDecisionSource` verifies an exact request ID, version, hash and decision before the
use case records actor/source/evidence. Those provenance fields cannot be supplied in the command.
The CLI pathway requires a fresh confirmation on the runtime-owned TTY; redirected input fails
closed. The adapter shows the subject and reason, requires an exact phrase, serializes prompts
and expires them after two minutes. The actor is the local OS account. The IPC client allows
130 seconds for a decision, and server idle timeout applies to idle/partial requests, not active
handlers. Headless runtimes must use the GitHub pathway rather than treating JSON as a terminal.

The GitHub pathway reads an Issue comment by numeric ID through `gh api`, pinned to the
configured repository. It accepts a human `User` actor in the configured allowlist and a strict
JSON body with `schemaVersion: 1`, `approvalId`, `subjectHash`, `version`, `decision`, and optional
`reason`. The actual comment author's login is authoritative; actor fields in the body are
rejected. Rejections require a reason matching the command. Bot, prose, malformed, unavailable,
wrong-version, wrong-hash and unallowlisted evidence fails closed. Conversation bridges are not
accepted by these use cases; the older domain representation remains available for later work.

After asynchronous verification, the use case reads the subject again, then commits state and
audit synchronously with compare-and-swap. Expired/changed subjects become expired/invalidated
and return a refusal. `checkExecutionApprovals` reads durable requests and current subjects for
requirements supplied by the trusted plan immediately before execution. It requires all supplied
business/cost gates and rejects missing, rejected, expired or stale evidence. The future dispatch
use case must call this service; dispatch is still NOT_IMPLEMENTED in the current IPC skeleton.

## Persistence and compatibility

`0003-approval-lifecycle.sql` rebuilds the existing approvals table: the v2 table requires
non-null completed decision fields and cannot represent pending requests, lifecycle status,
scope/evidence/rejection reason or optimistic versions. Keep indexed decision columns plus a
validated JSON request snapshot; all writes use the existing StateUnitOfWork transaction with
append-only audit. No additional table, dependency, module or guard exception is introduced.

Preserve legacy completed rows and indexes. Legacy rows lack full subject/scope provenance;
the reader does not manufacture executable requests from them. They remain available as history,
and a new request is required. A rejected/approved row must have matching decision and provenance;
pending rows must not contain completed decision fields. Restart and rollback tests cover this.

OMI-024 also adds a migration in parallel. This task's distinct name is
`0003-approval-lifecycle.sql`; integration must order/renumber unapplied migrations contiguously
before either is applied together. Applied migration history must never be rewritten.

## Limits

Local OS/TTY and SQLite are cooperative boundaries, as architecture.md §11 already specifies;
processes sharing the OS account are not isolated. A GitHub credential shared with a PO also
cannot prove that a human authored a message. Projects must configure distinct actors and retain
native GitHub/pipeline gates for release/deploy. This decision does not replace native review.
Live GitHub authentication and real terminal interaction remain opt-in validation; default
integration tests use real SQLite/IPC and fake trusted confirmation/read-back I/O.
