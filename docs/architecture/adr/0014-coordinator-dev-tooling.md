# ADR-0014 — Coordinator dev tooling lives in `tools/coordinator/`

- Status: Accepted
- Date: 2026-11-10
- Issue: #61 (OMI-050), epic #1, milestone M0 — Feasibility
- Context documents: `docs/architecture/architecture.md` §3, §14; ADR-0011 (tools run through
  Node type stripping); ADR-0012 (Coordinator on Windows, workers in WSL2)

## Context

Until the `omi` CLI and runtime exist (OMI-011, OMI-016, OMI-030), the PO's Windows Claude Code
session coordinates this repository by hand (ADR-0012, Consequences). Every new session spent a
long prompt and many LLM turns on deterministic work: reading the Project, finding unblocked
Ready tasks, checking PR checks, creating branches, merging with the reviewed head, closing
Issues. The PO decided on 2026-11-10 that deterministic operational steps go through scripts and
the LLM is used only for judgement (OMI-050).

architecture.md §3 limited `tools/` to "build, codegen, architecture checks", so the scripts had
no place in the folder map.

## Decision

1. Widen the `tools/` row of architecture.md §3 to also hold **Coordinator dev tooling for
   developing this repository** — temporary, replaced by the `omi` CLI. No new root directory,
   layer or `src/` module; `tools/check-structure.ts` needs no change because it does not
   constrain subdirectories of `tools/`.
2. The tooling lives in `tools/coordinator/` and is run with `node tools/coordinator/<x>.ts`
   (ADR-0011 type stripping, erasable syntax only, no new dependency):
   - `status.ts` — Project items by Status, Ready tasks whose blockers are all closed, open PRs
     with checks and review state, WSL workers. `--json` for machines.
   - `flow.ts` — the mechanical steps of a task: `set-status`, `start-branch`, `push`, `check`,
     `open-pr`, `merge`, `close`, `cleanup`. Each reads the current state first and is
     idempotent; `--dry-run` prints the argv it would run and changes nothing (no fetch either).
     `merge` requires green required checks, the newest agent review `PASS` on the exact head
     and merge state `CLEAN`/`HAS_HOOKS`. `close` ticks the Issue's Acceptance criteria from the
     `AC-<n>: met|not met` lines of the agent review `PASS` on the merged PR's head and refuses
     on a missing line or `not met` (OMI-051). `pick-profile` chooses the worker profile by
     quota (OMI-053, below).
   - `quota.ts` — worker subscription quota (OMI-053), read in one WSL call by a small Node
     collector sent on stdin (the bash payload stays quote-free): **Codex** through
     `codex app-server` JSON-RPC `account/rateLimits/read` (no model call, free); **Claude** from
     the newest `rate_limit_event` in the worker logs `~/omi-runs/omi-NNN-<profile>-<ts>.jsonl`
     (the log name carries the profile; older logs without it are ignored unless
     `legacyLogProfile` is set). Claude has no free read: `--probe` spends one minimal
     `claude -p --model haiku --max-turns 1 --tools ""` call per profile, so `status.ts` never
     probes and `/omi-next` probes once before dispatch. Results are redacted at the parse
     boundary (percentages, reset times, status, plan, reset-credit count, data age; never
     `accountId`, emails, tokens or credit ids). `pickProfile` is pure: score = share left of the
     tighter window minus a penalty for the profile sharing the Coordinator's account; stale or
     missing data ranks below fresh; below the thresholds in `coordinator-settings.ts` it refuses
     with the earliest reset. Codex reset credits are only reported; spending one is a PO
     decision. Log mtime is the Claude data time, and an undocumented app-server method may
     change with codex-cli versions. Temporary: OMI-004 runtime quota detection replaces it.
3. All process execution goes through one injectable runner (`spawn`, `shell: false`, argv
   arrays). The only shell strings are `bash -lc` payloads handed to
   `wsl.exe -d <distro> --cd <repo> --exec bash -lc <payload>`; each argument is POSIX-quoted and
   a payload containing `"`, `\` or a newline is rejected, because Windows rewrites those when it
   builds the wsl.exe command line. Inside Linux (the scripts run in the WSL checkout) the same
   payload runs in `bash` directly. Branch state is read with the same git argv list in the WSL
   checkout and in the Coordinator's Windows clone.
4. Pure logic (parsing, Ready filtering, check/review classification, idempotency decisions) is
   kept apart from I/O and unit-tested in `tests/unit/tools/coordinator/`.
5. Project field option IDs and required checks are read live from GitHub, never hard-coded.
6. Skills `.claude/skills/omi-status` and `.claude/skills/omi-next` (architecture.md §3:
   `.claude/` holds Claude Code instructions for developing this repository) call the scripts.

## Boundaries

- This is not product code. `src/` must never import `tools/` (already enforced by
  `.dependency-cruiser.cjs`), and the product CLI must not reuse these scripts: OMI-019…024
  implement GitHub/Git delivery in `src/infrastructure/` behind application ports.
- When `omi status` / `omi run` exist, the skills switch to the CLI and `tools/coordinator/` is
  deleted rather than kept in parallel (one behaviour, one implementation).
- The scripts encode only repository coordinates (owner, repo, Project number, WSL checkout);
  the WSL distro and checkout can be overridden with `OMI_WSL_DISTRO` / `OMI_WSL_REPO_DIR`.

## Alternatives considered

- **Put the scripts under `src/`.** Rejected: they would bypass the layer rules (direct `gh`
  and process calls) and pre-empt the CLI design of OMI-011/OMI-030.
- **Keep everything in skill prompts.** Rejected: the LLM re-derives deterministic steps every
  session, which costs tokens and makes idempotency depend on the model remembering state.
- **A new root directory (e.g. `scripts/`).** Rejected: a new root entry for temporary tooling
  is more structure, not less; `tools/` already holds `node`-run TypeScript tools.

## Consequences

- `tools/coordinator/` is verified by `npm run check` (typecheck, lint, format, unit tests).
- The Windows/wsl.exe path is exercised only by the Coordinator on Windows; CI and WSL runs use
  the Linux branch of the same runner. OMI-030 still owns the tested product bridge.
- Residual risk (OMI-051): the worker allowlist in `/omi-next` is narrow (specific git
  subcommands, read-only `gh`, `npm run`/`npm ci`, `node`) and `git push`, `git reset --hard`,
  `gh api` and `npm install` are denied, but a worker can still run arbitrary code through
  `node` or `npm run` with the PO's WSL `gh`/git login, so the allowlist limits mistakes, not a
  hostile worker. A separate read-only token for workers is a PO decision and out of scope here
  (OMI-004 / runtime). Agent review comments are also not tied to an author yet; any account
  that can comment on the PR could post a `VERDICT: PASS` line.
