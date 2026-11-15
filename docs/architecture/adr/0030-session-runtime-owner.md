# ADR-0030 — Session launcher and fenced WSL2 runtime owner

- Status: Accepted for implementation; Windows-host validation remains open below.
- Date: 2026-11-11
- Issue: #19 (OMI-016)
- Sources: ADR-0012, ADR-0017, ADR-0018, ADR-0020, ADR-0023, ADR-0028.

## Decision

The Windows foreground `omi session start` launcher starts `wsl.exe`, holds its stdin pipe,
waits for a bounded `ready` line, then starts the Windows Coordinator (default `claude`).
The command is registered in the existing CLI skeleton; dependency injection supplies the
launcher through an application port. Starting a runtime cannot be an IPC request to a server
that does not exist yet, so session start is a local bootstrap operation, outside the v1 IPC
command vocabulary. It does not change the existing command schemas or error/exit codes.

Example after building/installing the framework (run the CLI with Windows Node):

```text
node <Windows-package-path>/dist/bootstrap/cli.js session start --distribution Ubuntu-24.04 --project /home/user/project --runtime /home/user/project/.omi-squad/tool/node_modules/omi-squad/dist/bootstrap/runtime.js
```

Paths passed to WSL must be absolute Linux paths. Arguments are separate argv entries,
`shell: false`; no path is interpolated into a shell command. The installer/bridge will supply
these paths (OMI-045/OMI-030). The Coordinator inherits the launcher's terminal and Windows
working directory; launch from the intended Coordinator workspace. The supplied executable is
trusted local configuration, not Issue or worker text. A custom `--socket` is refused for this
command so it cannot silently differ from the runtime's project socket.

Ctrl-C, SIGTERM or SIGHUP on the launcher, or Coordinator exit, sends `stop` and closes stdin.
The launcher waits for the runtime with a bound. A hung relay is killed by its own child handle;
this is explicitly **unconfirmed WSL teardown**, reported as failure, never as a stopped worker.
If the runtime ends first, the launcher stops its Coordinator child. There is no background
service or independent `session stop` IPC command: the managed foreground owner is the stop
path. EOF on abrupt launcher death and heartbeat loss on a frozen launcher use ADR-0028.
A Windows forced termination cannot run JS shutdown handlers; the runtime detects EOF or
heartbeat loss instead. No native Windows graceful termination behavior is claimed here.

`bootstrap/runtime.ts` opens the project-local database and claims `project-owner` in the
existing `leases` table. It uses a random session owner id, acquisition timestamp and increasing
generation, not a PID lock. A live lease refuses a second owner before migration upgrades,
IPC binding or worker spawn. A fresh database must first apply migration 0001 to create the
lease table; SQLite serializes this initialization. Existing databases acquire ownership before
applying pending migrations. No additional lock or dependency is introduced.

`claim-project-session.ts` owns lease acquisition, renewal, fenced writes, audit and release.
`session-runtime.ts` owns process handles and pipe liveness, reusing `watchOwnerLiveness` and
`startSupervisedProcess` (the same group cancellation primitive used by `owned-worker-run`).
It installs liveness before readiness; tracks spawning workers as well as running ones; refuses
worker starts after owner loss or renewal failure; closes IPC admission; interrupts every owned
group; waits through grace and escalation; records `session.interrupted` and worker exit facts;
then releases the project lease. Renewal continues during shutdown. Files are not cleaned up.
Startup failure follows the same stop/audit/release path. Neither dispatcher nor checkpoints
nor recovery engine are implemented here.

Every state write made through a session carries its lease owner/generation in the existing
SQLite unit of work transaction. A `session_event` target adds audit-only session records and
requires a fence. Expired but unreleased project leases can be reclaimed with a higher generation;
the previous generation cannot renew, release, commit state, append audit or queue outbox work.
If a session loses its lease, its runtime stops; it cannot record a terminal event or release a
successor's lease. This failure is surfaced, and its old lease/audit are left for recovery.
Future dispatcher mutations must use the session's fenced commit, not an unfenced store.

This fencing protects SQLite state, **not arbitrary filesystem writes by orphaned CLI processes**.
A dead runtime's worktree writer reservations remain under OMI-010/OMI-021's explicit-release
leases; a successor must not reclaim those workspaces just because the project lease expired.
OMI-027 owns reconciling process identity/start time/generation and proving old writers gone.
No startup path here looks up or signals an old PID or launches recovered work.

`domain/runs/agent-attempt.ts` defines `pending → running → succeeded | failed | interrupted |
cancelled`, plus pending cancellation. Start requires a lease; all completion events require the
current generation and a stopped writer; success additionally requires a valid result. Terminal
attempts cannot restart: retry is another attempt. Migration 0005 rebuilds `agent_attempts` with
exactly this status CHECK, preserving rows, process identity checks, unique attempts, index and
incoming artifact references. Unknown legacy statuses abort and roll back rather than guessing.
The domain vocabulary is distinct from executor result reason/outcome codes.

## Defaults and open decisions (PO)

Named constants live in `processes/session-timing.ts`, with one-line reasons:

1. Heartbeat every **1 s**, lost after **10 s**: tolerates ordinary host scheduling stalls.
   This resolves ADR-0028 open decision 2 provisionally; validate sleep/resume and busy Windows
   hosts before treating these values as a product latency promise.
2. Worker grace **15 s**: reuse ADR-0023's CLI flush window. This resolves ADR-0028 open decision 3
   provisionally; measure real CLIs mid tool write before tuning it.
3. Project lease **60 s**, renewed every **1 s**, including worker shutdown. Readiness and
   launcher shutdown waits default to **30 s**. A stalled runtime may retain writer processes;
   lease expiry fences database writes but does not authorize reusing their worktrees.
4. Decide Windows-host acceptance evidence for graceful shutdown, hung launcher, sleep/hibernate,
   and hung `wsl.exe`; coordinate installer path mapping and Coordinator working directory with
   OMI-045/OMI-030. Windows forced termination of the launcher may also leave the Windows
   Coordinator itself running; only WSL runtime/worker liveness is covered by the pipe.
5. Recovery, durable per-attempt process references, checkpoint semantics, dispatch integration
   and worktree orphan reconciliation remain with OMI-017/OMI-026/OMI-027. No task is resumed here.

## Tests and evidence

All tests use temp databases/projects and stand-in executables; none calls real WSL, GitHub,
Claude or Codex. Every signalled process was created by the test or its runtime.

| Test file | Evidence |
| --- | --- |
| `tests/unit/domain/runs/agent-attempt.test.ts` | Exact lifecycle, terminal immutability, lease requirement, stale generations, writer-stop and result guards |
| `tests/integration/persistence/agent-attempt-status.test.ts` | Migration 0005 accepts exactly domain statuses, rejects invalid INSERT/UPDATE, preserves legacy data and artifact FK, rolls back invalid legacy rows |
| `tests/integration/processes/session-runtime.test.ts` | Competing SQLite owners, renewal/release, expired unreleased takeover, stale audit/outbox rejection, all four owner-loss paths, owned-only escalation, preserved files, startup failure, spawn/shutdown race |
| `tests/integration/processes/windows-session-launcher.test.ts` | Injected spawn with real Linux children: argv, readiness before Coordinator, heartbeats, graceful stop, bounded hung runtime, startup failure, malformed input |
| `tests/integration/processes/session-entrypoint.test.ts` | Real runtime executable in temp project: IPC status, second start refused, graceful stop, socket removed, audited release, restart and EOF stop |
| `tests/integration/processes/session-cli.test.ts` | CLI input → injected launcher, JSON result, validation and unconfirmed teardown failure |
| Existing ADR-0028 process tests | Group member cancellation and unrelated process survival; pipe and signal mechanics |

Local validation on 2026-11-11: `npm run check` passed typecheck, build, lint, formatting,
architecture/structure, frozen backlog validation and schema drift, plus 698 unit tests,
396 integration tests and 228 contract tests (87 files, 1,322 tests total). No live suite was run.

The historical migration-0004 test is bounded to versions through 0004 so its exact history
assertions continue testing that upgrade independently of later migrations. Its constraints,
rollback checks and expectations are retained.

## Limits not proven

Real `wsl.exe` was not invoked in this task. ADR-0028's earlier Windows abrupt-exit evidence is
consumed, not claimed as a new production launcher run. Graceful and hung Windows-host paths,
Windows process signal behavior, startup latency, sleep/hibernate, `wsl --shutdown`, production
CLI interruption mid tool call, runtime SIGKILL/OOM, escaped process groups and PGID reuse remain
unverified. A blocked runtime event loop delays heartbeat detection and renewal. A kill can
interrupt a file write; preserving files does not establish their consistency. Independent
review and checks on a merged revision belong to the Coordinator's separate review/merge run.

## Recovery boundary (OMI-027)

`pause-run` and `resume-run` operate serially under the `ProjectSession` already claimed by the
runtime. They renew and verify that lock before work, after awaited boundaries and before
continuation; they retain it on return. The session runtime continues its normal renewal during
long operations. The bootstrap recovery factory binds use cases to that session; the workflow
supplies the current authorization/check validator and a `dispatchStep` binding from its trusted
plan. No checkpoint next-action text authorizes an operation. Runtime IPC/vertical-slice command
registration remains with the bridge composition work.

The process recovery adapter consumes existing supervised handles, never adopts a persisted PID
and never signals an old process by lookup. `track` persists PID, boot id plus kernel start ticks,
and writer generation in the existing attempt process columns through the fenced SQLite store.
Both CLI executors expose a synchronous `onWorkerStarted` observer before returning a handle;
`createRunProcessRecovery` wires it to the process store and recovery adapter. It must run before
a caller treats the spawn as recoverable. Persistence failure cancels the
owned handle. A spawn/recording crash without an identity is unknown and requires reconciliation;
it is never assumed dead. After restart the adapter inspects the entire group and releases a
writer reservation only after proving it absent. A live inherited process, mismatched identity,
or stale generation refuses recovery. Owned handles may be stopped for pause; the adapter waits
for the existing supervisor's group exit before taking a snapshot. Accepted terminal attempt
statuses without process references rely on the result recorder's existing writer-stopped contract.

Checkpoint reconciliation reports typed missing-file, hash-mismatch, invalid-file and incomplete
reasons, including on later passes over interrupted rows. Resume selects the newest intact valid
file and reports any discarded newer checkpoints. It checks manifest identity, worktree path,
head, branch, dirty state, bounded uncommitted hashes and output files before remote reconciliation.
Truncated, excluded or unhashed uncommitted entries require explicit resolution rather than an
unverifiable match. No stash, reset, drop, cleanup, transcript read or credential copy occurs.

Current gates are revalidated after remote reconciliation. Already succeeded step rows remain
unchanged even when the checkpoint predates their acceptance. Only interrupted/paused steps are
readied; failed steps keep the retry/rework authorization boundary. A continuation uses a fresh
attempt and writer generation through the existing dispatcher. Partial recovery commits can be
retried from running state, with compare-and-swap and project fences preserving accepted results.
The run remains running for the workflow's normal completion/delivery gates; recovery does not
mark a task Done.

## Decision update 2026-11-11

PO-approved decisions for OMI-070 (#142):

`session new` and `coordinator switch` are handoff-only: checkpoint and pause active runs
and record the handoff. Neither command automatically relaunches a session or switches a login.
