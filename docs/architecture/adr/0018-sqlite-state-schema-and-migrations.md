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
   `BEGIN IMMEDIATE` and rolls back on any throw. If the work returns a promise it is refused and
   rolled back, because better-sqlite3 cannot keep a transaction open across an `await`.
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

## Consequences

- An applied migration is never edited; schema changes go in a new numbered file.
- Status columns other than `step_runs.status` are free TEXT until their domain state machines
  exist. A later migration can add CHECKs.
- Not yet covered: backup before migration, an integrity check, a recovery procedure, a
  read-only snapshot mode and repositories/ports. These belong to later Issues (tech-stack.md
  §6).
