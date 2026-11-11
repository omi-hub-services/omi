# ADR-0018 — SQLite state schema v1 and checksummed migration runner

- Status: Accepted
- Date: 2026-11-10
- Issue: #11 (OMI-009), epic #8, milestone M1 — Core foundation
- Context documents: `docs/architecture/architecture.md` §3.3, §8; `docs/engineering/tech-stack.md`
  §6; `docs/engineering/design-patterns.md` §6–§8; ADR-0011 (toolchain)

## Decision

1. **better-sqlite3 13.0.3** (exact, MIT, runtime dependency) and **@types/better-sqlite3 9.6.0**
   (exact, MIT, devDependency). This is the driver tech-stack.md §2 already chose and ADR-0011
   left to the Issue that needs it. The native module was checked on the WSL2 Node baseline
   (bundled SQLite 3.53.4). Only `src/infrastructure/` may import it; dependency-cruiser already
   forbids it in application and interfaces. No ORM or query builder.
2. **Connection** (`sqlite-connection.ts`): every connection sets `foreign_keys=ON`,
   `journal_mode=WAL`, `synchronous=FULL` and a finite `busy_timeout` (default 5000 ms, must be a
   positive integer), reads each pragma back, and fails if SQLite did not accept it. The state DB
   must be a file; `:memory:` is refused because it cannot use WAL or survive a restart.
3. **Transactions** (`sqlite-transaction.ts`): `runInTransaction` runs synchronous work in
   `BEGIN IMMEDIATE` and rolls back on any throw. Its type rejects promise-like return values,
   including unions containing them. Native async functions are refused before invocation, so
   their writes before or after an `await` cannot run. A returned promise-like from another
   function is still refused and its synchronous writes rolled back. This runtime fallback
   cannot cancel an already scheduled continuation; such a continuation must never use the
   connection after the callback returns. better-sqlite3 cannot keep a transaction open across
   an `await`.
4. **Migrations** (`migration-runner.ts`): plain SQL files `migrations/NNNN-kebab-name.sql`,
   numbered contiguously from 0001. The runner owns the `schema_migrations` history table
   (version, name, SHA-256 checksum, applied time). It creates the table itself so the first
   migration does not have to create it. One run of the runner is one `BEGIN IMMEDIATE`
   transaction: a concurrent process waits, and a failing migration leaves the DB unchanged.
   Migration files therefore must not contain `BEGIN`/`COMMIT`. The runner refuses, and applies
   nothing, when an applied migration's checksum or name changed, or when the DB records a
   version the code does not know (a newer schema). The checksum is taken over the SQL with
   CRLF normalised to LF, so a Windows checkout of the same file is not reported as tampered.
   The runner takes the migrations directory as a parameter. Bootstrap will resolve it.
   For table rebuilds, the runner disables foreign key enforcement before `BEGIN`, checks
   `foreign_key_check` before committing, and restores and verifies enforcement in `finally`.
   It refuses an existing transaction before changing connection settings: SQLite cannot toggle
   foreign keys inside a transaction. Rebuilds create a replacement table, copy rows, drop the
   original, rename the replacement, then recreate the original indexes and triggers. They do
   not rename the original first, which would rewrite child foreign key references.
5. **Schema v1** (`0001-initial-state.sql`): the 14 tables of architecture.md §8, all `STRICT`.
   Local IDs and timestamps are TEXT values passed in by the application, so the domain never
   reads IDs or time implicitly. Foreign keys use NO ACTION, so a parent row with children
   cannot be deleted. Each §8 uniqueness rule maps to a constraint:
   - One active run per task: a partial unique index on `workflow_runs(task_id)` with
     `WHERE closed_at IS NULL`. A replacement run can be opened only after the old one is closed.
   - One holder per lease resource (one writer per worktree, one supervisor per project):
     `leases.resource_key` is the primary key, and `generation` is the fencing token.
   - One operation key per external action: `outbox.operation_key UNIQUE`.
   - Process references carry their start time and generation: a CHECK rejects a bare PID.
   - `events` is append-only: triggers abort UPDATE and DELETE, and `AUTOINCREMENT` keeps
     `sequence` monotonic.
   - Step status is CHECKed against the §8 state list. `step_runs.iteration` lets rework run the
     same step again inside one run.
6. **Schema v2** (`0002-state-constraints.sql`): rebuild `workflow_runs` with the exact
   `RUN_STATUSES` vocabulary and `approvals` with the `Approval.decision` vocabulary
   (`approved`, `rejected`). An approval decision is distinct from an approval request's lifecycle
   status (`pending`, `expired`, `invalidated`). Rebuild `checkpoints` and `artifacts` to reject
   empty paths, leading slash or backslash, Windows drive prefixes and parent traversal segments
   with either separator. Preserve valid rows, foreign key references, indexes and audit triggers.
7. **Schema v4** (`0004-outbox-state.sql`, OMI-024; v3 is `0003-approval-lifecycle.sql`,
   ADR-0026): rebuild `outbox` with a CHECK on `state`
   that lists exactly `OUTBOX_STATES` (`domain/delivery/outbox-operation.ts`), a CHECK that a
   `succeeded` row has a remote identity, and two new nullable columns, `next_attempt_at` and
   `last_error`. A row with a state outside the list makes the whole migration roll back; nothing
   is rewritten or guessed. The decision and the state machine are in ADR-0025.

## Additive registry and attempt settings (OMI-015, Issue #18)

Migration `0006-profile-registry.sql` extends existing tables; it adds no dependency or module.
`profile_observations.metadata_json` is a strict, validated metadata snapshot. Existing rows stay
unchanged with NULL metadata and remain observation history, not registered profiles. New snapshots
keep the existing availability/cooldown columns consistent with the metadata. The latest snapshot
by observation ID is authoritative even if a clock moves backwards. Registry saves compare the
expected observation ID before appending, so an in-flight probe cannot overwrite a newer disable
or cooldown. Tool, profile directory and account group identity are immutable after registration.
Only one Codex profile may be registered (PO decision 2026-11-11).

Selection reads registered profiles and counts pending/running attempts in the same short
`BEGIN IMMEDIATE` transaction that inserts the selected pending attempt. This reserves both profile
and account-group capacity across connections. Waiting creates no attempt. Step lifecycle and
writer-stop fencing remain the responsibility of the run use cases, not this registry adapter.

`agent_attempts.model_id` is the chosen CLI model. `chosen_effort`, `actual_model` and
`actual_effort` are additive nullable columns; legacy NULLs mean unknown. New selections always
write chosen model/effort. `ExecutorSelectionStore.recordResult` checks the attempt, tool and
requested settings against the reservation before recording only reported actual settings.
Unreported actual settings remain NULL, and conflicting replays are refused. It does not store
prompts, transcripts, auth data or raw result diagnostics, nor does it mark attempts terminal.

## Consequences

- An applied migration is never edited; schema changes go in a new numbered file.
- Remaining free-TEXT status columns (`agent_attempts.status`) need their own domain vocabulary
  before a migration can constrain them (OMI-016, #19). Integration tests pin persisted constrained values to the domain types.
- Not yet covered: backup before migration, an integrity check, a recovery procedure, a
  read-only snapshot mode and repositories/ports. These belong to later Issues (tech-stack.md
  §6).
