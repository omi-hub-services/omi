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
     on a missing line or `not met` (OMI-051). Since OMI-052 an agent review is only a
     `VERDICT` comment posted by the Coordinator account (`COORDINATOR_LOGIN` in
     `coordinator-settings.ts`); `VERDICT` comments from other accounts are ignored and
     `status.ts` lists them under "Attention". `close` only takes evidence from PRs of this
     repository and uses the one merged last (`mergedAt`). An AC is a top-level checkbox
     directly under `## Acceptance criteria`; nested checkboxes, checkboxes in a code fence and
     anything under a `###` sub-heading are not counted. `pick-profile` chooses the worker
     profile by quota (OMI-053, below).
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
     missing data ranks below fresh and is never chosen without `--probe` (OMI-052); a reported
     limit only blocks while a window is still to reset; below the thresholds in
     `coordinator-settings.ts` it refuses with the earliest reset. Codex reset credits are only reported; spending one is a PO
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

## Model and effort policy (OMI-058)

`flow.ts pick-profile N` keeps quota-based profile selection unchanged, then uses the existing
Issue GraphQL read for Workflow, Work Type, Area, Priority and labels. `effort-policy.ts` is
pure; AC counts reuse `acceptance-criteria.ts`'s top-level counting convention. Rules, in order:

- An exact `complexity:low|medium|high` label overrides inference, including missing fields.
  Conflicting labels choose the highest complexity, independent of label order.
- Any missing/blank Project field defaults to `medium`, naming the missing fields in the reason.
- Research, Spike/PoC, runtime/adapters/github with live tests, or P0 with more than five AC
  selects `high`. The live-test signal is the existing `--kind claude+codex-live`; PoCs normally
  use Workflow research or Work Type Spike (literal PoC values are also recognized).
- Workflow docs or Work Type Docs selects `low`; otherwise one to three AC in a non-runtime
  Area selects `low`. Domain, runtime, adapters and github are treated as runtime code Areas;
  zero AC does not establish a small task. Remaining work defaults to `medium`.

`coordinator-settings.ts` owns the mapping: Claude uses `claude-sonnet-5-5` at low/medium and
`claude-opus-5-5` at high; Codex uses `gpt-6.1-sol` throughout; the Claude reviewer subagent uses
`sonnet` at low/medium and `opus` at high. Effort matches complexity for all three. This reserves
Opus for high complexity while keeping Codex's model stable. Output includes model, effort,
complexity and reason for each chosen tool and the reviewer; `--json` adds the same fields to
`chosen` and `reviewer`, with the decision also at the top level. Refusals remain refusals.
The Coordinator consumes this advice and passes explicit CLI flags; no model invocation,
retry escalation or native CLI configuration change is introduced by this policy. OMI-057
replaces this temporary tooling in the product.

## Issue creation and readiness gate (OMI-059)

New task Issues are created only through
`node tools/coordinator/flow.ts new-issue --file <spec.md> [--dry-run]`.
`issue-spec.ts` owns pure parsing, validation and next-key allocation; `issue-creation.ts`
performs I/O through the existing injectable runner. No new dependency or product module.

The Markdown spec starts with YAML frontmatter. All keys below are required; `milestone`
is the exact GitHub milestone title, `epic` is an existing Epic Issue number, and `blockedBy`
is a list of existing Issue numbers (an empty list is allowed). Single-select values must
match the live Project options. Creating Epics is outside this command's scope.

```markdown
---
title: Validate a task
priority: P1
workType: Task
workflow: feature
role: Developer
area: tooling
milestone: M1 — Core foundation
epic: 1
blockedBy: []
---
## Mục tiêu
Make task input complete.
## Phạm vi
Validate task input.
## Acceptance criteria
- [ ] Incomplete input is refused.
## Dependencies
None.
```

The command validates local input before contacting GitHub, then reads live field options,
all repository Issues (including closed Issues), Project Plan Keys and milestones. Reads of
Issues, Project items and milestones are paginated. It allocates the largest existing
`OMI-NNN` key plus one, considering body markers, title prefixes and Project values; Epic
keys do not consume task keys. It adds `[OMI-NNN]` to the title and the bootstrap-compatible
`<!-- omi-squad:plan-key=OMI-NNN -->` marker to the body, creates the Issue with its milestone,
adds it to the Project, sets Priority, Work Type, Workflow, Role, Area, Plan Key and Status
`Backlog`, then attaches native parent and blocked-by relationships.

A real run saves the allocated marker into the spec **before** creating the remote Issue.
Keep that spec for retries: if its marker already exists on an Issue, the command prints
`done:` without creating another Issue. This also means a remote failure after creation
requires the Coordinator to inspect and finish any incomplete Project/relationship writes;
`done:` acknowledges the existing Issue, not atomic completion of all writes. Do not remove
the marker and retry after such a failure. Run one creation at a time: allocation is a
read-then-write operation, not a cross-process lock. `--dry-run` prints the key, title, body,
fields, milestone and relationships without changing GitHub or the spec. Invalid input
prints `refused:` and performs no writes.

`issue-readiness.ts` is a pure gate shared by flow and status. An Issue needs an `OMI-NNN`
Project Plan Key matching exactly one body marker, nonblank Priority, Work Type, Workflow,
Role and Area, and at least one top-level AC using the existing counting convention.
`set-status N Ready|"In Progress"` and `start-branch N <slug>` refuse with all reasons before
any writes or git probes, including when the requested status/branch would otherwise be
already done. Other status transitions retain their existing gates. `status.ts` adds an
Attention line for each open non-Epic Issue failing readiness, including legacy Issues
already In Progress or Done; it reports them without throwing or repairing them. Closed
Issues, Epics, PRs and drafts are excluded from readiness warnings.

## Promoting Backlog tasks (OMI-060)

`node tools/coordinator/flow.ts promote [N] [--dry-run]` moves a Backlog Issue to Ready so
`/omi-next` does not stop on a task nobody moved by hand. `promote.ts` holds the pure rules;
`flow.ts` does the I/O through the injectable runner.

- `promote N` reads the Issue (Status, native blocked-by, readiness fields) and prints
  `done:` when it is already Ready. It prints `refused:` with every reason, and writes nothing,
  when the Issue is an Epic, is not in Backlog, has an open blocker (or more blockers than
  were read), or fails the readiness gate. Otherwise it runs `set-status N Ready`.
- `promote` without `N` picks the first Backlog Issue by the `status.ts` order (Priority,
  milestone, Issue number; Epics skipped) whose blockers are all closed and that passes the
  readiness gate, then handles it exactly like `promote N`. With no candidate it says so,
  exits 0 and writes nothing.
- The only write is the existing `set-status` plan, so its readiness gate still applies.
  `--dry-run` prints the `gh project item-edit` it would run and performs none.
- `status.ts` shows the same candidates under "Backlog, all blockers closed" (`backlog` in
  `--json`), produced by the same `promotableBacklog` function. It does not change Priority,
  move a task back to Backlog, or repair Issues that fail the gate (those stay Attention lines).

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
- Residual risk (OMI-051, updated OMI-052): the worker allowlist in `/omi-next` is narrow
  (specific git subcommands, read-only `gh`, `npm run`/`npm ci`, `node`) and `git push`,
  `git reset --hard`, `gh api`, `npm install`, `git commit --no-verify`/`--amend` and
  `git switch --discard-changes`/`-C`/`-f`, `git commit -n*` and `git switch --force*` are
  denied, but a worker can still run arbitrary
  code through `node` or `npm run` with the PO's WSL `gh`/git login, so the allowlist limits
  mistakes, not a hostile worker. A separate read-only token for workers is a PO decision and
  out of scope here (OMI-004 / runtime).
- Known gap, accepted by the PO (OMI-055): deny rules match a command prefix, so a flag placed
  after other arguments (`git commit -m x --no-verify`, `git commit -m x --amend`) is not
  caught. Only the flag-first forms are blocked.
- Agent review comments are bound to the Coordinator account (OMI-052): another account's
  `VERDICT: PASS` no longer counts for `merge`, `close` or `status`. What remains is that the
  binding is to an account, not to a review run: anything that can post as the Coordinator's
  `gh` login — the Coordinator session itself, or a worker whose WSL `gh` login is that same
  account — could still post a `VERDICT` line. The separate worker token above closes that.
