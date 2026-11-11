# ADR-0028 — PoC: the runtime stops its worker group when the Coordinator side is gone

- Status: Accepted for the **runtime half** (live-run on WSL2, 2026-11-11). The **Windows half is
  not proven** and the Issue must not be closed on this evidence alone (see "Product blocker
  check").
- Date: 2026-11-11
- Issue: #6 (OMI-005), epic #1, milestone M0 — Feasibility
- Context: ADR-0012 (Coordinator on Windows, runtime and workers in WSL2), ADR-0013 and ADR-0021
  (CLI worker PoCs), ADR-0023 (process layer); architecture.md §5; tech-stack.md §7
- Consumed by: OMI-016 (Windows launcher + WSL2 runtime owner), OMI-030 (bridge), OMI-045 (doctor)

## Context

ADR-0012 moved the Coordinator to Windows and left one question open, named as the core of this
task: can a runtime in WSL2 reliably notice that the Coordinator is gone, without seeing Windows
PIDs, and then stop exactly its own worker process group without losing the worker's uncommitted
files and without touching anything else on the machine?

## Decision

### Mechanism: a pipe the owner holds, a heartbeat on it, and a process group the runtime created

1. **The owner holds a pipe to the runtime** (the runtime's stdin). Across the boundary the holder
   is the long-lived `wsl.exe` child of the Windows launcher (ADR-0012 §2). The runtime never
   inspects a PID of the owner.
2. **Three signals on that pipe mean "owner gone"** (`src/infrastructure/processes/owner-liveness.ts`):
   - EOF / close / error → `channel-closed` (what an abrupt owner exit produces);
   - a `stop` line → `stop-requested` (graceful goodbye);
   - no line at all for `heartbeatTimeoutMs` → `heartbeat-lost` (pipe open but owner hung or
     frozen; EOF can never report that).
   A fourth reason, `signal`, covers the runtime itself receiving SIGTERM/SIGHUP (for example when
   `wsl.exe` is terminated and the relay signals the process).
3. **Handlers before readiness.** The pipe listeners, the heartbeat clock and the signal handlers
   are installed synchronously inside `watchOwnerLiveness`, before the worker is spawned and before
   the runtime prints `ready`. A caller that announces readiness afterwards has no window in which
   an owner exit is missed. Signal handlers stay installed until the run ends, so a repeated
   SIGTERM cannot kill the runtime halfway through stopping the group (which would orphan it).
4. **Stop exactly the group the runtime created** (`owned-worker-run.ts`, `runWorkerUnderOwner`):
   the worker is started by the existing `startSupervisedProcess` (`detached`, so it leads its own
   process group; the group id is the worker pid). On owner-gone the runtime sends SIGINT to
   **that group** (new `cancel(signal, "group")`), and after `graceMs` SIGKILL to that group only
   if it is still alive; group members that outlive the leader are killed at close, as before.
   No process is looked up by name, pattern or parent; no other pid or pgid is ever signalled.
   `SupervisedProcess` now also exposes `pid` (= pgid) so the owner of the run can record it.
5. **Nothing is cleaned up.** Stopping is a signal, not a cleanup: no `git clean`, `reset`,
   `checkout`, `rm` or directory removal exists in this path. Uncommitted files in the worker's
   directory therefore stay.
6. **`ownerGone` is exposed as a promise** on the run so a dispatcher can stop handing out work the
   moment the owner is gone; the dispatcher itself (OMI-016) does not exist yet.

### Why not other mechanisms

| Idea                                              | Verdict                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PID of the Coordinator                            | Not possible: WSL2 cannot see Windows PIDs (ADR-0012), and PIDs are reused.                                      |
| `prctl(PR_SET_PDEATHSIG)`                         | Not available from Node without a native addon (no new dependency allowed), and it keys on the parent *thread*.  |
| A hook that runs when the Coordinator exits       | Not reliable: a hook does not run on SIGKILL or a crash (architecture.md §5).                                    |
| Polling a lease file                              | Needs a clock and a writer; the pipe gives EOF for free and heartbeat covers the rest.                           |
| Kill by process name (`pkill claude`)             | Forbidden: it would hit other sessions on the machine (AC-4).                                                    |

### Tests

| Where                                                                            | What                                                                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/processes/owner-liveness.test.ts` (in `npm run check`)        | Every reason, split chunks, repeated and late events, dispose, fake timers for the heartbeat; nothing real is signalled                         |
| `tests/integration/processes/owned-worker-run.test.ts` (in `npm run check`)      | Real worker + tool subprocess, in-memory pipe: group stopped, files kept, SIGKILL escalation, unrelated process survives, spawn failure         |
| `tests/integration/processes/supervised-process.test.ts`                         | `pid` exposed; `scope: "group"` interrupts a group member that `scope: "child"` would not                                                        |
| `tests/live/wsl-lifecycle/wsl-lifecycle.test.ts` (opt-in, WSL2 only, no quota)   | Five scenarios across real processes and a real pipe, below                                                                                      |

Live topology, every process created by the test and recorded by pid:

```text
test ── launcher.ts   (stand-in for the Windows launcher + wsl.exe: holds the pipe, sends heartbeats)
          └─ runtime-entry.ts   (stand-in for the WSL2 runtime: watches stdin)
               └─ worker.ts     (own process group) ── tool subprocess (same group)
test ── an unrelated process in its own group
```

Run: `node node_modules/vitest/vitest.mjs run tests/live/wsl-lifecycle` (or `npm run test:live`,
which also runs the other live suites and fails the Claude one without its profile variable). On a
kernel that is not WSL2 the suite fails with an explicit message; it never skips silently.

Safety: the live test signals only ids it created and registered (`OwnedProcesses` refuses any
other id, including 0 and 1). Fixtures never run `kill` by name.

Each scenario starts a git repository with a modified tracked file, a staged new file and a file
the worker writes, so "uncommitted files are kept" is checked against `git status --porcelain` and
the exact contents, not just file existence.

## Evidence

Live run on Ubuntu / WSL2 (kernel 5.15.167.4-microsoft-standard-WSL2), Node v24.22.2, 5/5 passed
in 2.7 s (one run, one machine; written to the gitignored
`.tmp/live/omi-005-wsl-lifecycle-evidence.json`). `detectMs` is from the trigger until the test
sees the worker and its tool subprocess gone.

| Scenario                                                          | Trigger                                    | Reason reported        | Worker                                    | `detectMs` |
| ----------------------------------------------------------------- | ------------------------------------------ | ---------------------- | ----------------------------------------- | ---------- |
| graceful owner exit                                               | launcher SIGTERM → `stop` line, EOF        | `stop-requested`       | SIGINT, checkpointed, exit 0              | 11         |
| abrupt owner exit                                                 | launcher SIGKILL, kernel closes the pipe   | `channel-closed`       | SIGINT, exit 0                            | 13         |
| hung owner                                                        | launcher SIGSTOP (pipe stays open)         | `heartbeat-lost`       | SIGINT, exit 0                            | 969 (timeout 1000 ms, heartbeat every 100 ms) |
| runtime told to end                                               | SIGTERM to the runtime                     | `signal` (SIGTERM)     | SIGINT, exit 0                            | 10         |
| abrupt exit, worker ignores SIGINT                                | launcher SIGKILL                           | `channel-closed`       | SIGKILL of the group after 500 ms grace   | 508        |

In every scenario: the tool subprocess in the worker's group died with it; `tracked.txt`,
`staged.txt` and `worker-output.txt` kept their exact content and git status; the unrelated
process was still running; the runtime exited after writing its report.

A mutation check was made during development: with the `cancel` call removed, all nine live and
integration cases for this feature fail, so the tests do depend on the behaviour.

## Acceptance criteria (Issue #6)

| AC                                                       | Status                             | Evidence                                                                                              |
| -------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Supervisor notices Coordinator exit, stops the group  | Evidenced on Linux/WSL2; Windows half **not proven** | `owner-liveness.ts`, `owned-worker-run.ts`; live scenarios 1–5; integration tests                    |
| 2. Graceful and abrupt stop tested                       | Evidenced (plus hung and runtime-signal) | live "graceful" and "abrupt" scenarios; integration channel `end`/`destroy`/`stop`                    |
| 3. Uncommitted files kept                                | Evidenced                          | `git status --porcelain` and exact contents asserted in every live scenario; integration test         |
| 4. No process outside the framework is killed            | Evidenced for a same-user unrelated process in its own group | live test asserts it still runs after every scenario; integration test too; `OwnedProcesses` guard |

## Product blocker check (ADR-0012, Issue #6 scope change)

The Issue requires proving the detection **across** the boundary (a Windows Coordinator exiting
gracefully and abruptly, seen through a `wsl.exe` that holds the pipe) and says to report a product
blocker rather than close the Issue by hand if it cannot be shown reliably.

- **Proven here:** everything on the WSL2 side of the pipe. Given a pipe whose holder dies, exits
  gracefully or freezes, the runtime detects it and stops exactly its worker group in about 10 ms
  (EOF/stop) or one heartbeat timeout (hang).
- **Not proven here:** that a real `wsl.exe` forwards a Windows-side pipe closing as EOF on the
  runtime's stdin when the Windows launcher is killed. `wsl.exe` is not on the PATH of this worker
  environment (`which wsl.exe` exits 1), and the stand-in launcher is a Linux process, not
  `wsl.exe`. This is **a gap in the evidence, not a negative result**.
- **Consequence:** the heartbeat is not optional. Even if `wsl.exe` keeps the pipe open after its
  parent died (for example because another Windows process inherited the handle), the missing
  heartbeat is detected; a Windows launcher that is killed stops sending it.

To close the gap, run on the Windows host (OMI-016/OMI-030 owner, or the PO): a small Windows
launcher that starts `wsl.exe -d <distro> --exec <node> <runtime-entry>` with piped stdio, sends a
heartbeat line every 100–250 ms and `stop` on graceful exit; then kill that launcher from Task
Manager / `taskkill /F` and check that the worker group in WSL2 stops. If the pipe EOF does not
arrive, the heartbeat path must carry the abrupt case alone and its timeout becomes the abrupt-exit
latency; if neither arrives, it is the product blocker the Issue describes.

## Limits not proven

- **Real `wsl.exe` and a real Windows launcher** (above). Also not measured: `wsl.exe` start-up
  and per-line latency, behaviour when the distro is shut down (`wsl --shutdown`, which stops
  everything and is a recovery case, architecture.md §5), Windows sleep/hibernate, which stops
  heartbeats on both sides at once and may look like a lost heartbeat on resume.
- **The runtime itself dying uncatchably** (SIGKILL, OOM, crash). Nothing is left to stop the
  worker group, and Node has no parent-death signal; the group is orphaned. This was not run. The
  design answer is recovery on the next start (architecture.md §5: session/process carry start time
  and generation) and OMI-016's single-owner lease.
- **A worker that leaves its group** (`setsid`, `nohup` with a new session, a daemonised tool).
  Only the created group is signalled, so such a process survives by design; it is also not
  reported.
- **Real Claude/Codex CLIs under this lifecycle.** The stand-in worker proves the process
  mechanics; SIGINT behaviour of the real CLIs is as recorded in ADR-0013/ADR-0021 (tool-less
  runs), and a CLI mid tool call was not exercised.
- **Partial writes.** SIGKILL after the grace period can interrupt a write; this PoC keeps files,
  it does not prove they are consistent. Checkpointing is the worker/runtime's job (OMI-016).
- **A blocked runtime event loop** would delay detection; the heartbeat clock lives on that loop.
- **Pid reuse.** The group is signalled only while it is alive and only by the runtime that created
  it, but a pgid that fully emptied and was recycled within the grace window is not guarded
  against beyond the existing `isGroupAlive` check.
- **Timing figures** are one run on one machine; they are not a latency guarantee.
- The runtime's own "paused/interrupted checkpoint" and "stop dispatching" (architecture.md §5)
  are not built; this PoC provides the signals (`ownerGone`, group stop) they will hang on.

## Consequences

- New code stays inside the existing module `src/infrastructure/processes/`; the folder map and
  dependency rules are unchanged (no ADR needed for structure). No dependency was added.
- `SupervisedProcess` gains `pid` and `cancel(signal, scope)`; the default scope is `child`, so the
  Claude adapter (OMI-013) behaves exactly as before.
- OMI-016 builds the Windows launcher and the runtime owner on these two modules: pass the
  runtime's stdin as `channel`, choose `heartbeatTimeoutMs` (this PoC used 1–10 s with 100 ms
  heartbeats), and keep `SIGTERM`/`SIGHUP` in `signals`.
- OMI-016 decides what the runtime does after `ownerGone` beyond stopping the group (checkpoint,
  state, exit code).

## Open decisions

1. **Close Issue #6?** The runtime half is evidenced; the Windows half needs one run on a Windows
   host (procedure above). PO/Coordinator decides whether to accept it as a follow-up inside
   OMI-016 or to hold the Issue open.
2. **Heartbeat period and timeout** for production (a trade-off between false positives after a
   Windows sleep or a busy host and abrupt-exit latency when EOF does not arrive).
3. **Grace period** between SIGINT and SIGKILL for real CLI workers (ADR-0023 default 15 s) when the
   cause is the Coordinator leaving.
