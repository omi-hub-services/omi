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
     `open-pr`, `sync` (OMI-069, below), `merge`, `close`, `cleanup`. Each reads the current state first and is
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
     the OAuth usage endpoint (OMI-065, ADR-0033: free, realtime, per-model weekly windows such
     as `Fable 99%`), falling back to the last good cached API/probe reading, then the newest
     `rate_limit_event` in the worker logs
     `~/omi-runs/omi-NNN-<profile>-<ts>.jsonl` on an expired token, HTTP error or unknown shape
     (the log name carries the profile; older logs without it are ignored unless
     `legacyLogProfile` is set). `--probe` spends one minimal
     `claude -p --model haiku --max-turns 1 --tools ""` call per profile and takes precedence
     over both, so `status.ts` never probes and `/omi-next` probes once before dispatch.
     Per-model windows are display only unless assigned to the worker; `pick-profile` automatically
     checks its inferred Claude model (`--model NAME` overrides that check) and refuses a profile whose
     window for that model is below the 7d threshold. Results are redacted at the parse
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

`flow.ts pick-profile N` uses the existing
Issue GraphQL read for Workflow, Work Type, Area, Priority and labels before selecting profiles,
so the inferred Claude model participates in weekly quota filtering (OMI-068). `effort-policy.ts` is
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

## Terminal watch (OMI-064)

Run `node tools/coordinator/watch.ts [--interval <seconds>]` in a terminal pane (default 5
seconds). Workers refresh at that interval; quota is read every five minutes without paid
probes. Each worker uses its stdout log from `/proc/<pid>/fd/1` for task/profile, turn count
and the last action. Claude counts assistant messages (the result's `num_turns` is authoritative);
Codex counts `turn.started` events. Logs are streamed to count the whole run while retaining
only the last action, so counts do not reset at a tail window. `p` asks `y/N` before spending
one Haiku call per Claude profile; `q`, Ctrl-C or SIGTERM restores the cursor and terminal.
Finished workers are grey, errors/rate limits red, quota below pick-profile thresholds yellow,
and readings older than 30 minutes dim. Missing WSL is shown and retried on the next poll.
This extends the existing worker reader and runner; it adds no dependency or product module.

## Web watch (OMI-067)

`node tools/coordinator/watch-web.ts [--port 4317] [--open]` serves the same workers and quota
as the terminal watch on a small localhost page (`/omi-watch` opens it). `--open` starts an Edge
`--app` window of 440×460 (default browser as fallback); if `GET /health` on the port already
answers `omi-watch`, it only opens another window and exits. The server uses `node:http`, binds
`127.0.0.1` only and rejects any `Host` or `Origin` other than `127.0.0.1:<port>` or
`localhost:<port>` (DNS rebinding). `GET /events` is SSE, one snapshot per data change (workers
every 5 seconds, quota every five minutes). The snapshot is built by a pure function and the page shows
external strings only through `textContent`, under a CSP that allows its two inline blocks by
hash. `POST /probe` runs the paid Haiku probe only with the header `X-Omi-Watch: 1`, which the
page sends after the user confirms in the UI; nothing probes automatically. The server exits 60
seconds after the last SSE client disconnects, or after start if none ever connects. Polling,
colour rules and text cleaning are shared with `watch.ts` in `watch-core.ts`; the terminal watch
stays as the fallback. No dependency is added.

## Carrying a review PASS over a clean sync (OMI-069)

The `develop` ruleset requires branches to be up to date, so a PR that waited for another merge
goes `BEHIND`. Merging `origin/develop` into the branch changes its head, and `merge`/`close`
want a PASS on the exact head, which used to cost a full review although the task's own change is
unchanged. `node tools/coordinator/flow.ts sync <branch> --reviewed <sha> [--dry-run]` carries the
PASS over the sync without an LLM:

1. It fetches and refuses unless the checkout is clean on `<branch>`, `<branch>` and
   `origin/<branch>` are at `<sha>`, an open PR into `develop` exists, and the newest review of the
   Coordinator account on the PR is a `PASS` on `<sha>` (a carried PASS counts only if its own
   chain holds, below).
2. It runs `git merge --no-edit origin/develop` (no rebase, no force-push). On a conflict it runs
   `git merge --abort` and refuses with the conflicted files; nothing is pushed or posted.
3. It runs the `check` step on the new head, then `push`, then posts as the Coordinator
   `**VERDICT:** PASS · **REVIEWED_HEAD:** \`<new>\` · **CARRIED_FROM:** \`<sha>\`` with the
   merge commit, the `origin/develop` commit merged in, the check result and the `AC-<n>` lines
   of the old review copied verbatim (so `close` can still tick the Issue).

A re-run is idempotent: it prints `done:` once the carried PASS is on the head and the head is
pushed, and it resumes a run that stopped after the merge (failed check, failed push or comment).
`--dry-run` fetches nothing, merges nothing and posts nothing; it previews conflicts with
`git merge-tree`.

**What makes a carried PASS valid.** `merge` and `close` never trust the comment text. A PASS
with `CARRIED_FROM` counts only if git shows that the head is a merge commit whose first parent
is the `CARRIED_FROM` commit, whose second parent is an ancestor of `origin/develop`, and whose
tree equals the tree of `git merge-tree --write-tree <parent1> <parent2>`. A merge commit that
was edited by hand, a conflict resolution (that merge does not apply automatically), or a merge
of something not yet on `develop` fails this and is refused as a wrong-head PASS. When the source
commit itself holds a carried PASS, the same test applies to every hop down to a PASS that a
review posted (bounded at 20 hops). The decision is the pure `judgeCarriedHead`
(`carried-pass.ts`); `carry-git.ts` only reads the facts through the injectable runner. A carried
PASS from another account is ignored like any other `VERDICT` (OMI-052). `status.ts` shows it as
`PASS @head (carried from <sha7>)`; it reads comments only, so the git test happens at `merge` and
`close`.

**Conflicts: reduced review.** A conflicting sync is resolved by hand and so gets no carried
PASS. The reviewer does not review the task again: they check only the conflict resolution, that
is the diff between the tree git merges automatically (`git merge-tree --write-tree` of the two
parents, which keeps the conflict markers) and the new head, plus that the check passes, and post
an ordinary `VERDICT` on the new head with `AC-<n>` lines. The Coordinator's `/omi-next` skill
uses `sync` when a reviewed PR goes `BEHIND` and sends only conflicts to this reduced review.

Out of scope: changing the ruleset, a merge queue, rebasing or force-pushing task branches. No
dependency is added.

## Worker log retention (OMI-056)

Worker stream-json logs in WSL `~/omi-runs` grew without bound. `flow.ts cleanup <branch>` now
ends with a log step for that task, and `flow.ts prune-runs` runs the same step once for every
task whose Project Status is Done. Both take `--dry-run` (which still lists the directory, but
changes nothing) and are safe to re-run. `runs-retention.ts` holds the pure rules; `flow.ts`
reads one listing and applies the result with one bash script, both through the runner.

- Scope: only `omi-NNN-*` files of the selected task(s). `quota/`, `watch.mjs` and other files
  (for example `smoke-*`) are never touched.
- Kept at the root: the newest `omi-*.jsonl` of each profile (the part of the name before the
  timestamp, across all tasks), so `quota.ts` and `status.ts` read what they read before; files
  held open by a process (`/proc/*/fd`) or written in the last 30 minutes.
- Deleted: empty `.err` and `omi-NNN-current`.
- Archived: everything else of the task (`.jsonl`, `.err`, `.md`, `.log`) is moved to
  `~/omi-runs/archive/` and gzipped.
- `archive/` is capped by `RUNS_RETENTION` in `coordinator-settings.ts`: files older than 30 days
  go, then the oldest until the total is at most 50 MB. The cap sees the archive as listed, so
  files archived by the same run count at the next one.
- A failed `cleanup` of the branch (refused or error) skips the log step.

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

## Linked-worktree cleanup (OMI-062)

`flow.ts cleanup <branch>` reads `git worktree list --porcelain -z` in the configured WSL
checkout. The first entry identifies the main checkout; a later entry with the task branch
identifies its linked worktree. Before removing it, cleanup reads tracked and untracked changes
there, excluding `node_modules`. Changes produce `refused:` with the file list and skip branch
and log cleanup. The merged-into-`origin/develop` gate still applies.

For a clean linked worktree, cleanup runs `git fetch origin`,
`git switch --detach origin/develop`, then `git branch -d <branch>` inside that worktree
(OMI-063). The detached HEAD contains the merged task even when the main checkout is on
another task branch. Only then does it run `git -C <main> worktree remove -- <path>` and
`git -C <main> merge --ff-only origin/develop` when the main checkout is on `develop`.
This path never force-deletes. A failed command stops the remaining steps and log retention.
Cleanup does not switch the main checkout's branch. Its existing main-checkout cleanup
behaviour is unchanged.

The log-retention step runs from the surviving main checkout after worktree removal. If the
configured WSL directory has already disappeared, cleanup reports `refused:` rather than
assuming the branch is gone: the main repository cannot be discovered from that directory.
It names `git -C <main-checkout> branch -d <branch>` for recovery after verifying the branch
is merged into `origin/develop`, with a HEAD containing the branch; it skips log retention.
An already absent branch in an accessible checkout reports `done:`. A dry run only probes and
prints the planned commands; it does not fetch, remove a worktree, update refs or change logs.

## Watch and quota resilience (OMI-068)

The collector shares a redacted last-good Claude cache and endpoint call reservations under WSL
`~/omi-runs` (ADR-0033), including across separate status/watch processes. Both watch modes use the
five-minute minimum in `coordinator-settings.ts`; multiple web windows reuse one localhost server
and poller. Expired reset times use one pure display function and are omitted; window percentages
return to 100. Poller failures go to `onError`: terminal cleanup/rejection via `fail`, or one-line
web logging with the server kept alive. Worker parsing includes parent PIDs and collapses a Codex
wrapper/binary pair to its root process; matching stdout JSONL paths also collapse duplicate rows.
