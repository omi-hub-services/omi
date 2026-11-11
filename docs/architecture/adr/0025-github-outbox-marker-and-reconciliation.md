# ADR-0025 — GitHub outbox, operation marker and reconciliation before retry

- Status: Accepted
- Date: 2026-11-11
- Issue: #28 (OMI-024), epic #22, milestone M2 — Execution. Also closes the `outbox.state` CHECK
  moved from #73 (OMI-054).
- Context documents: `docs/architecture/architecture.md` §8, §11, §16;
  `docs/engineering/design-patterns.md` §7, §11, §15; ADR-0015 (GitHub capability matrix);
  ADR-0017 (state machines); ADR-0018 (state schema and migrations)
- Out of scope: the concrete operation kinds beyond Issue/comment/PR creation (merge is OMI-023
  with `merge-state.ts`, Project field updates are OMI-019), the `omi sync` command and its wiring
  in `bootstrap/` (no CLI exists yet), a daemon or timer that calls the use cases.

## Context

Every GitHub side effect is recorded as an intent in the local `outbox` before the remote call.
A request that times out, or whose response is lost, may or may not have taken effect. A local
`UNIQUE (operation_key)` stops a duplicate row, not a duplicate Issue, PR or comment on GitHub.
The goal is therefore **idempotency by reconciliation** (design-patterns.md §7): before a
send is repeated, read the remote and look for proof that the first one landed. This is not an
exactly-once guarantee and nothing in code or docs should say so: a read-back can only prove what
GitHub shows at that moment.

## Decision

1. **Outbox state machine in the domain** (`domain/delivery/outbox-operation.ts`, built on
   `shared/transition.ts`): `pending`, `in_flight`, `outcome_unknown`, `succeeded`, `failed`.
   - A send starts only from `pending` (`begin_attempt`, which needs `now >= notBefore` and an
     unspent attempt budget).
   - The only way back to `pending` after an unknown outcome is `reconciled_absent`, and it
     needs a grace period since the unknown outcome. `reconciled_found` goes to `succeeded`.
     There is no edge from `outcome_unknown` to `in_flight`.
   - `rejected_retry` (GitHub refused, applied nothing) goes back to `pending` and does not need a
     read-back. `attempt_rejected_final` and `give_up` go to `failed`; `failed` reopens only with a
     recorded decision id.
   - `in_flight` is persisted **before** the call. A crash leaves it behind; the next
     reconcile turns it into `outcome_unknown`.
2. **Migration 0004** (`0004-outbox-state.sql`; 0003 is the approval lifecycle of ADR-0026) adds the CHECK on `outbox.state` (list pinned to `OUTBOX_STATES` by an
   integration test), a CHECK that `succeeded` carries a remote identity, and the columns
   `next_attempt_at` (Retry-After / rate-limit reset / backoff, persisted so it survives a
   restart) and `last_error` (a short code, never remote text).
3. **Operation marker** (`domain/delivery/operation-marker.ts`): the adapter appends
   `<!-- omi-squad:operation:<operationKey> -->` to the body of every Issue, comment and PR it
   creates. Operation keys are restricted so the marker stays inside one HTML comment; a key that
   cannot form a marker is never sent. The marker ends with a delimiter so `a:1` does not match
   `a:12`. It is de-duplication evidence only, never an authorisation or approval.
4. **Use cases** (`application/use-cases/sync/`): `reconcile-github` settles `in_flight` and
   `outcome_unknown` rows by marker search and never sends. `flush-outbox` runs reconcile first,
   then sends due `pending` rows, one attempt per row per pass, and stops the pass on a rate-limit
   refusal, an unknown outcome or an unreadable GitHub. Both depend on ports: `OutboxStore`,
   `GithubRemote`, `ArtifactStore` (payload pinned by sha-256). They are meant to be run
   serially by the single runtime writer; they do not lock.
5. **What counts as "not applied"** (`infrastructure/github/github-rest-client.ts`): only an
   answer from GitHub that is a refusal (429, or 403 with Retry-After / exhausted limit / a
   rate-limit message, and every other 4xx) is `rejected`. A write that times out, loses its
   connection or gets a 5xx or an unreadable success body is `unknown` and is **not repeated by
   the client**. Reads are repeated freely with exponential backoff and jitter (the existing
   `backoffDelayMs`). Waits follow `Retry-After` (seconds or date) and `X-RateLimit-Reset`; a wait up
   to `maxInlineWaitMs` is slept inside the call, a longer one is handed to the outbox as
   `next_attempt_at`. An exhausted primary limit also holds back the next request.
6. **Read-back** (`github-remote.ts`) lists the owning collection and scans bodies for the marker:
   issue comments of that issue, the repository's issues (skipping PRs), pull requests filtered
   by head and base. It uses plain REST listings and not the search API, because a search index
   that lags would read as "absent". `absent` is reported only when the listing was read to the
   end; a failed page or the page limit gives `unavailable`, which leaves the row unchanged.
7. **Grace period** (`reconcileGraceMs`): a request that timed out may still be running on
   GitHub. Silence is trusted only after the grace period, which must exceed the transport
   timeout. Finding the marker is accepted at any time.
8. **Transport**: `gh api --include` through `execFile` (argv and stdin, no shell, no token in
   this process), behind a `GithubTransport` seam so tests use an in-memory fake GitHub.
9. The contract tests of this task live in `tests/contract/github/` and run through
   `npm run test:contract`, which `npm run check` includes (the script line is identical to the one
   OMI-013 added on `develop`).

## Consequences

- Offline GitHub keeps every local row; the next pass reads before it writes, so what already
  landed is recorded instead of repeated.
- A marker is text anyone who can edit the remote body could forge or delete. A forged marker
  makes an operation look done; a deleted one makes a repeat possible. The read-back is
  restricted to the target issue, repository or head/base branch, not to the author.
- Same-repository PR heads only; a fork head is not supported by the payload schema.
- An `outcome_unknown` row whose read-back keeps failing (for example a deleted issue answering
  404) stays unknown and needs a human; the machine has no automatic exit by design.
- `gh api --include` output shape follows the documented format and hand-written fixtures; it was
  not captured from a live run in this task. A live probe belongs in `tests/live/github/` when
  the sandbox is next used.
- Adding an operation kind means a schema in `contracts/github-operation.ts` and a send/list pair
  in `github-remote.ts`; the use cases and the state machine do not change.
