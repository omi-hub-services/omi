# ADR-0012 — Coordinator on Windows, runtime and workers in WSL2

- Status: Accepted — product decision by the PO, 2026-11-10 (Issue OMI-049)
- Supersedes: the product-overview.md §2 environment row for Coordinator placement (it said
  "các process chạy trong WSL2", which included the Coordinator); refines ADR-0006 (supervisor
  bound to the Coordinator).
- Affects: OMI-005, OMI-016, OMI-030, OMI-045, OMI-046

## Context

product-overview.md §2 fixed the first-version environment as "Windows qua WSL2; các process
chạy trong WSL2" and architecture.md §5 assumed one supervisor that launches the runtime and the
Coordinator in the same Linux environment. The PO works from a Claude Code session on Windows and
wants that session to be the Coordinator, while the agents that do the work run in WSL2.

## Decision

| Component                                                     | Runs on                              |
| ------------------------------------------------------------- | ------------------------------------ |
| Coordinator (main Claude Code session of the PO)              | Windows, native                      |
| Coordinator bridge (skill/instructions that call the CLI)     | Windows, in the Coordinator session  |
| `omi` CLI implementation, runtime, SQLite state, artifacts    | WSL2 (Ubuntu); a project is bound to one distro |
| Worker agents (Claude Code, Codex) and their process groups   | WSL2                                 |
| Repository checkout and task worktrees                        | WSL2 Linux filesystem (e.g. `~/…`)    |

1. **Call boundary.** The Coordinator never talks to the runtime over a socket across the
   boundary. It invokes the CLI through `wsl.exe -d <distro> --cd <repo> --exec <shim> <args>` with
   typed argv and reads versioned JSON from stdout. Unix-socket IPC (tech-stack.md §7) stays
   inside WSL2 between the CLI and the runtime. Prompt text and Issue bodies are passed as files
   or stdin, never concatenated into a command line. `--exec` runs the shim without the
   distro's shell, so arguments are not re-expanded (dollar signs, quotes, globs) as they would be
   after `--`. Windows still hands wsl.exe a single command-line string, so OMI-030 must test the
   quoting of every argument the bridge sends.
2. **Lifecycle.** A Windows-side launcher (`omi session start` on Windows) starts the runtime in
   WSL2 and then the Coordinator, and keeps a long-lived `wsl.exe` child connected to the runtime
   by a pipe. Pipe EOF or an explicit stop means "Coordinator gone": the runtime stops dispatching,
   interrupts workers, takes the paused/interrupted checkpoint (architecture.md §5) and exits. WSL
   cannot see Windows PIDs, so liveness must not rely on PID inspection across the boundary.
   This detection mechanism is unproven and is the core of OMI-005.
3. **Repository.** The authoritative checkout and all worktrees live on the WSL2 filesystem.
   Workers never operate on `/mnt/<drive>/…`. The Coordinator reads files through the CLI or
   `\\wsl$\<distro>\…` and does not edit the worker workspaces directly; code changes go through
   workers and PRs.
4. **Credentials and profiles.** Coordinator logins live on Windows; worker profiles live in WSL2
   (one `CLAUDE_CONFIG_DIR` / `CODEX_HOME` per account). Profile directories are never shared
   across the boundary, because rotating refresh tokens would invalidate each other. Several
   profiles of the same account still share one quota (account group, architecture.md §7).
5. **GitHub identity.** The Coordinator side and the worker side may use different GitHub
   accounts. A release PR into `main` must be created by an account other than the PO approver,
   because the `main` ruleset requires an approval that the author cannot give.

## Alternatives considered

- **Everything in WSL2, Coordinator included** (previous reading). Simplest lifecycle and IPC,
  but not how the PO wants to work.
- **Runtime and workers in Docker containers.** Rejected for v1: subscription logins and
  multiple profiles would have to be mounted into containers, the interactive Coordinator would
  still sit outside, and it adds a component that tech-stack.md §12 excludes.

## Consequences

- **OMI-005** proves cross-boundary lifecycle: graceful and abrupt Coordinator exit on Windows is
  detected in WSL2 (pipe EOF/heartbeat), the worker process group stops, uncommitted files survive,
  and no unrelated process is killed. If detection is not reliable, report a product blocker.
- **OMI-016** splits the supervisor into a Windows launcher and the WSL2 runtime owner; the single
  project owner and lease rules apply inside WSL2.
- **OMI-030** delivers the bridge on the Windows Coordinator side, calling the CLI through
  `wsl.exe`.
- **OMI-045** installs a Windows-side shim/launcher in addition to the project-local package in
  WSL2; `doctor` checks the distro, WSL interop and path mapping.
- **OMI-046** documents the two-sided setup (Windows Coordinator logins, WSL2 profiles).
- Extra latency per `wsl.exe` call (tens to hundreds of ms) is acceptable for coordination calls;
  long waits use the CLI `wait` command rather than polling.
- Until the runtime exists (bootstrap), the PO's Windows session coordinates by hand: it prepares
  task prompts, runs independent reviews, merges and updates the Project, while task work runs in
  a Claude Code/Codex session inside WSL2.
