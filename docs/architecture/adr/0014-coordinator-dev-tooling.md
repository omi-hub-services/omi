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

- A manual `complexity` Project single-select field (`low|medium|high`) wins first. An exact
  `complexity:low|medium|high` label otherwise overrides inference, including missing fields.
  Conflicting labels choose the highest complexity, independent of label order.
- Any missing/blank Project field defaults to `medium`, naming the missing fields in the reason.
- Research, Spike/PoC, security Workflow/Work Type/Area, runtime/adapters/github with live tests, or P0 with more than five AC
  selects `high`. The live-test signal is the existing `--kind claude+codex-live`; PoCs normally
  use Workflow research or Work Type Spike (literal PoC values are also recognized).
- Workflow docs or Work Type Docs selects `low`; otherwise one to three AC in a non-runtime
  Area selects `low`. Domain, runtime, adapters and github are treated as runtime code Areas;
  zero AC does not establish a small task. Remaining work defaults to `medium`.

`coordinator-settings.ts` owns the mapping: Claude uses `claude-sonnet-5-5` at low/medium and
`claude-opus-5-5` at high; Codex uses `gpt-6.1-sol` throughout. Fresh reviewer workers
use the same dispatch policy for their selected tool. The legacy reviewer advice in pick-profile
remains for output compatibility; dispatch owns the actual launch model/effort. This reserves
Opus for high complexity while keeping Codex's model stable. Output includes model, effort,
complexity and reason for each chosen tool and the reviewer; `--json` adds the same fields to
`chosen` and `reviewer`, with the decision also at the top level. Refusals remain refusals.
The Coordinator consumes this advice and passes explicit CLI flags; no model invocation,
retry escalation or native CLI configuration change is introduced by this policy. OMI-057
provides the product policy in `src/domain/agents/complexity-policy.ts` (ADR-0016).

**Scoped exception to AGENTS.md §1.4 / architecture §14.3 (one implementation):** until OMI-030
switches Coordinator dispatch to the product CLI, `tools/coordinator/effort-policy.ts` mirrors
only the pure complexity inference. The effort tooling does not import the product complexity implementation. A parity test
covers all branches, conflicting labels, manual fields, missing metadata and the default effort
mapping. The product domain is authoritative; a rule change updates both and the test. The
reason is to preserve the independent, Node-run Windows Coordinator tooling without adding a
cross-layer runtime dependency. `pick-profile` reads the manual field, refuses invalid values,
and continues reporting explicit model, effort and reason for worker flags and PO review.
The `/omi-next` consumer must keep passing those explicit settings rather than CLI defaults;
no skill or native configuration is changed by OMI-057.

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

## Framework port of intake (OMI-079)

The Issue-creation, readiness-gate and promote rules above now also exist in the product, as the
first replacement of `tools/coordinator/` by the `omi` CLI (this ADR's Boundaries): domain
`readiness-gate.ts`, `promotion-policy.ts`, `plan-key.ts`, `issue-spec-policy.ts`; use cases
`create-issue-from-spec.ts`, `promote-task.ts`, `set-task-status.ts`; ports `github-intake.ts`,
`github-task-board.ts`, `issue-spec-file.ts` with adapters in `infrastructure/github/` and
`infrastructure/config/`; CLI `new-issue`, `promote`, `set-status` (handbook §9). The gate counts
acceptance criteria with the existing `domain/tasks/acceptance-criteria.ts` parser. `dispatchStep`
refuses `TASK_NOT_READY` before it creates a branch when the runtime wires the live board reader.
`tools/coordinator/` is unchanged and still runs this repository; it is deleted, not kept in
parallel, once `omi` runs it (not part of OMI-079). Differences from the script: a missing
milestone sorts last explicitly (the script's `"~"` sorts first under `localeCompare`), the Plan Key
prefix is a `--prefix` option, and a closed Issue is refused by `promote`.

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
`--app` window of 560×760, see OMI-074 (default browser as fallback); if `GET /health` on the port already
answers `omi-watch`, it only opens another window and exits. The server uses `node:http`, binds
`127.0.0.1` only and rejects any `Host` or `Origin` other than `127.0.0.1:<port>` or
`localhost:<port>` (DNS rebinding). `GET /events` is SSE, one snapshot per data change (workers
every 5 seconds, quota every five minutes). The snapshot is built by a pure function and the page shows
external strings only through `textContent`, under a CSP that allows its two inline blocks by
hash. (Until OMI-092 `POST /probe` ran the paid Haiku probe from a page button; it is gone, see
the OMI-092 section below. The terminal watch's `p` key still asks first.) The server exits 60
seconds after the last SSE client disconnects, or after start if none ever connects. Polling,
colour rules and text cleaning are shared with `watch.ts` in `watch-core.ts`; the terminal watch
stays as the fallback. No dependency is added.

## Tasks view and lifecycle diagram (OMI-074)

The web watch replaces its Workers section with **Tasks**: one card per open Issue whose Project
Status is `In Progress` or `In Review` (Epics and draft items excluded), In Progress first, then
by Priority and Issue number. The terminal watch prints one line per task above its Workers
section: `OMI-NNN workflow step phase role tool/profile` (OMI-075; was `... rework:N`). No collector was added: the Project items,
open PRs and their comments come from `readProject` (`github-reads.ts`, read every 60 seconds,
`TASKS_INTERVAL_MS`), the worker from `readWorkers` (every 5 seconds), both through the injected
runner. Checks are summarised over the checks the PR reports (no required-check read), so
`pass` means every reported check passed.

**Card.** Plan Key, Issue, title, Workflow and Priority (Project fields), PR number, short head
SHA and checks, the current step and who does it, the lifecycle diagram, the worker (tool,
profile, model, effort, elapsed time, turns, last action; `-` when none runs for the task), the
skills and the rules. A missing value is `-` and an underivable step is `unknown`, both with the
reason on the card.

**Step** (`deriveStep`, pure, `watch-tasks.ts`), in this order:

| Step        | Observed state                                                                                 | Role                |
| ----------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| `Done`      | Status `Done`                                                                                  | `-`                 |
| `Work`      | a worker process runs for the Plan Key and the Coordinator has posted no FAIL                  | Project Role field  |
| `Rework`    | the worker runs after a FAIL, or the newest Coordinator VERDICT on the head is FAIL; shown as `Work` with `rework k/2` (OMI-075) | Project Role field  |
| `Waiting PO` | no worker runs and the newest Coordinator comment (Issue, then PR) starts with `**WAITING-PO:** <reason>` (OMI-086) | `PO`                |
| `Blocked`   | no worker runs and the Issue has an open blocker; reason `blocked by #N, #M` (OMI-086)         | `-`                 |
| `Architect` | the newest VERDICT on the head is FAIL and an `**ARCHITECT:**` comment came after that FAIL    | `Architect`         |
| `Merge`     | the Coordinator posted PASS on the current head                                                | `Coordinator`       |
| `Review`    | In Review, PR open, no VERDICT on the current head (a stale one does not count)                | `Reviewer`          |
| `Verify/PR` | In Progress, no worker, and a PR without a VERDICT on the head, or the task was dispatched     | `Coordinator`       |
| `Start`     | In Progress, no worker, no PR and no `omi-NNN-prompt.md` yet (never dispatched)                | `Coordinator`       |
| `unknown`   | anything else, e.g. workers unreadable, Status not In Progress/In Review, In Review with no PR | `-`                 |

A running worker or the VERDICT on the head can decide a step even when the other source is
unreadable; otherwise unreadable workers give `unknown`. `Start` is told apart from `Verify/PR`
by the worker prompt file because a branch cannot be observed without git; the prompt exists as
soon as the Coordinator dispatches.

**Rework and Architect.** Rework count = comments by `COORDINATOR_LOGIN` whose line starts with
`**VERDICT:** FAIL`; any other account is ignored, as `status.ts` does. The Coordinator records
that it called the Architect with a PR comment of its own account:

```
**ARCHITECT:** <reason>
```

(the reason is required; a marker alone does not count). The `omi-next` skill posts the marker
(updated by the Coordinator, not by this task).

**Blocked and Waiting PO** (OMI-086). `Waiting PO` and `Blocked` replace the step the task stands
at, which is the step the rows below would give (kept as `at`). Blockers come from the `blockedBy`
field of the Project items query (number and state; no new query); Issue comments come from the
same query (`comments(last: 30)`). A running worker keeps `Work` and the card warns
`worker runs but blocked by #N`. The Coordinator records that it waits for the PO with a comment
of its own account on the Issue or the PR:

```
**WAITING-PO:** <reason>
```

(the reason is required, the marker starts the comment). It holds until a newer Coordinator
comment; other accounts are ignored. Issue comments are ordered before PR comments, because the PR
comes after the Issue (shortcut: no timestamps are read; upgrade if a PR comment ever precedes an
Issue one). `Waiting PO` wins over `Blocked`. The `omi-next` skill posts the marker (updated by the
Coordinator, not by this task).

*Diagram.* The node at `at` is drawn in state `blocked` (orange outline) with the sub-label
`blocked by #N` (`+k` when more are open) or `waiting PO`; earlier nodes stay `done`. The card
lists every blocker as `#N (open|closed)`; the terminal line ends with `blocked:#N,#M` or
`waiting-po`. Everything is rendered through `textContent` / `setAttribute`.

**Cycle phase** (OMI-075, `cyclePhase`, pure). The `2 + Architect + 2` cycle of design-patterns.md
is computed from the Coordinator-account comments, oldest first (other accounts are ignored):

| Phase              | When                                                        | Shown as                                       |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------- |
| `before-architect` | no marker and fewer than 2 FAILs                            | `rework k/2` (k = 0 to 1)                      |
| `architect`        | 2 FAILs and no marker; or a marker and no FAIL after it    | Architect node warns (needs a call) / is lit   |
| `after-architect`  | a marker and 1 FAIL after it                                | `rework k/2 (after Architect)`                 |
| `escalate-po`      | 2 FAILs after the marker (and any later FAIL)               | `Ask PO` warning node; no further loop is drawn |

A third FAIL without a marker stays in `architect` (the Coordinator still owes the call). The
first marker is the call; a later marker does not give two more reworks. A **marker before any
FAIL** counts as the call: the phase is `architect` with the node lit, the FAILs after it are the
"after Architect" reworks. In one comment the FAIL is counted before the marker.

The terminal line is `OMI-NNN workflow step phase role tool/profile`, with the phase as one token:
`rework:k/2`, `architect:needed`, `architect:called`, `after-architect:k/2` or `ask-po`, for
example `OMI-075 feature Work rework:1/2 Developer codex/ggtintran`.

**Skills and rules** are read from the worker's real prompt `~/omi-runs/omi-NNN-prompt.md` (one
WSL call per read; only the lines that match, never the prompt body): skills from the
`## Skill: <name>` headings that OMI-073 inlines, rules from the `AGENTS.md`, `CLAUDE.md` and
`docs/**/*.md` paths the prompt mentions, plus the worker restrictions (no push, PR or merge;
`gh` read-only). No prompt means `-` with the reason.

**Diagram.** An inline SVG per card, built by the page with `createElementNS`, `setAttribute` and
`textContent` (no `innerHTML`, nothing loaded from outside, CSP unchanged). Main row
`Start → Work → Verify/PR → Review → Merge → Done`. Above it a bold title `Workflow: <name>` (the
Project Workflow field, `Workflow: -` when empty), also at the start of the `aria-label`
(`OMI-NNN: Workflow: feature, current step Work, rework 1/2`).

Rework is not a node (OMI-075): it is going back to Work. With at least one Coordinator FAIL a
curved red edge runs Review → Work with the pill `FAIL ×N`; with 0 FAILs there is no edge and no
`×0`. While the task is in rework (a FAIL on the head, or the worker runs after a FAIL) `Work` is
the current node with the sub-label `rework k/2`, and the step shown is `Work` (`deriveStep` still
distinguishes `Rework` internally). From the 2nd FAIL, or once a marker exists, the `Architect`
node sits on the return path (Review → Architect → Work): dashed amber outline while there is no
marker, green with a blue outline once it is called, blue with a thick outline when it is the
current step. In `escalate-po` an `Ask PO` node with a dashed amber outline hangs under Merge,
reached by a dashed edge from Review, and no further loop is drawn. A card note `Cycle: ...`
repeats the phase in words, including "after Architect", which does not fit inside the node.

Node states come from the pure `diagramNodes(step, cyclePhase)`: past nodes are green (done), the
current node is blue with a thick outline, later nodes are plain. Every node carries its text
label, so colour is never the only signal. Colours are the existing CSS variables (light and
dark). The SVG scales to the card width (`viewBox`, unchanged `0 0 540 124`), so there is no
horizontal scroll.

The Edge app window is **560×760** (was 440×460 before OMI-074) to give the three-card case room
(`WINDOW_SIZE` in `watch-web.ts`); OMI-075 keeps that size.

Snapshot `workers` was replaced by `tasks` (`state: loading | unavailable | ok`). The Host/Origin
checks, the 127.0.0.1 bind, the `X-Omi-Watch` probe guard and the idle exit are unchanged. Workers
that belong to no In Progress/In Review task are no longer listed on the page (the terminal watch
still lists all of them).

## Diagram from the workflow template (OMI-088)

The diagram is drawn from the Issue's workflow template, not from the fixed `/omi-next` lifecycle.
`readTasks` loads `templates/project/workflows/<Workflow field, lower case>.yaml` for each distinct
Workflow of the active tasks (`loadTemplate`, `watch-workflow.ts`). It parses with the runtime's
own `workflowSchema` (`src/application/contracts/workflow.ts`) and the `yaml` package already
used by the tools, so there is no second parser. `watch-workflow.ts` imports
`tools/register-ts-imports.ts` and loads the schema with a dynamic `import()` after it, because
`src/` uses `.js` specifiers and the watch still starts with a plain `node` (no `--import`). The id
must match `^[a-z0-9][a-z0-9-]{0,39}$`, so a Project value cannot reach outside the template
directory.

**Nodes** (`orderNodes`, pure): the steps ordered by `needs` (stable, file order among equals),
each gate placed right before (`before`) or after (`after`) its step. A step node shows its id and
role; a gate shows `gate`. Selecting a node (click or Enter) shows its template skills and rules
under the diagram; the current step is shown by default. `feature` draws `analyze → scope-approved
→ implement → verify → review → ready-to-merge`; `bugfix` and `docs` draw their own steps and gates.

**State to template step** (`mapTemplatePos`, pure; input is the lifecycle step `deriveStep` already
gives, so Blocked, Waiting PO, Rework and Architect keep their rules):

| Observed step (lifecycle) | Template position                                                     |
| ------------------------- | --------------------------------------------------------------------- |
| `Start`                   | before the work step: analyst steps and the scope gate done, work step todo |
| `Work`, `Rework`          | the developer step (`workStepId`)                                     |
| `Verify/PR`               | the first `qa` step                                                   |
| `Review`, `Architect`     | the first `reviewer` step (done while the Architect is current)       |
| `Merge` (PASS)            | gate `ready-to-merge`                                                 |
| `Done`                    | every node done                                                       |
| `unknown`                 | no node current; the reason of `deriveStep` stays on the card          |
| no matching step or gate  | `unknown` with a reason, e.g. `workflow x has no qa step`             |

Analyst steps are done once the Issue is Ready or In Progress: the Coordinator writes the spec
when it creates the Issue. Several developer steps (`bugfix`: `reproduce`, `implement`) run in one
worker session, which cannot tell them apart, so the last one is shown (shortcut; upgrade if a
workflow ever dispatches developer steps separately). Blocked and Waiting PO draw the node the
task stands at as `blocked`; the 2 + Architect + 2 cycle, the `FAIL ×N` pill and Ask PO are
unchanged. Rework is the red edge from the reviewer step back to the developer step
(`flow.from` / `flow.to`), through Architect once it exists. The card title stays
`Workflow: <id>`; the step line adds the template step, `Step: Work (implement)`.

**Role and skills.** The role on the card is the current template step's role (`developer`, `qa`,
`reviewer`); Architect, Waiting PO and Blocked keep their own roles. Skills stay the ones actually
loaded (`## Skill:` headings of the worker prompt) and are compared with the current step's
template skills (`compareLoaded`): a loaded skill the step does not list is marked `≠ loaded, but
the template gives it to <step>` (or `does not use it`), a listed skill that was not loaded is
marked `≠ in the template step, not loaded`; an exact match says so. Example: the Coordinator
loads `verification-before-completion` for the developer worker while the template gives it to
`verify`. Template rules are ids (`project-baseline`) and the prompt names files (`AGENTS.md`), so
rules are shown side by side and not compared.

**Fallback.** When the Workflow field is empty, the template is missing, unreadable or invalid, or
was not read, the card draws the previous lifecycle diagram and says why
(`Template: <reason> (lifecycle shown)`); the terminal line is unchanged. The page is drawn with
`createElementNS`, `setAttribute` and `textContent` only; the CSP and the dependencies are
unchanged. Template nodes are laid out in rows of four inside the same 540-wide viewBox, so there is
no horizontal scroll. The framework watch (#164) is out of scope.

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

## Worker commands (OMI-077)

The omi-next skill used to make the LLM compose five deterministic things in every task: the
worker launch command, the skills in the prompt, the report out of the worker log, the
commit of a Codex worker's output and the format of the review comment. They are now
`flow.ts` subcommands (script-first, AGENTS.md §9; the same principle ships to projects as the
rule `script-first`, architecture.md §2). Each takes `--dry-run`. `flow-workers.ts` does the I/O
through the injectable runner; the pure parts are `worker-launch.ts`, `worker-report.ts`,
`worker-commit.ts` and `review-verdict.ts`. No dependency and no product module is added.
`<issue>` is the Issue number; the task number `NNN` of the files comes from its Plan Key.

```
node tools/coordinator/flow.ts dispatch <issue> --profile <p> [--kind claude|codex] [--resume <id>] --prompt <file> [--dry-run]
node tools/coordinator/flow.ts worker-report <issue> [--dry-run]
node tools/coordinator/flow.ts commit-worker <branch> --message-file <f> [--dry-run]
node tools/coordinator/flow.ts review-comment <pr> --file <f> [--dry-run]
```

- **`dispatch`** reads the Issue (Plan Key, Role, Workflow and the complexity of the effort
  policy above), refuses a profile that is not a `WORKER_PROFILES` entry of that tool, then:
  1. writes the rendered prompt file **unchanged**, for fresh and resumed workers, to WSL
     `~/omi-runs/omi-NNN-prompt.md`. Step skills/rules are owned by `prompt` below; no role-based
     curated skills are inserted. A findings-only packet requires `--resume`; a fresh worker
     requires a full packet;
  2. launches the worker **in the foreground** (an 8-hour limit instead of the runner's 2
     minutes; the Coordinator backgrounds the command) in the checkout of `OMI_WSL_REPO_DIR`.
     Claude: `CLAUDE_CONFIG_DIR` of the profile, `ANTHROPIC_*` credentials unset,
     `claude -p --disable-slash-commands --model <m> --effort <e> [--resume <id>]
     --output-format stream-json --verbose --max-turns 200 --permission-mode acceptEdits` with the
     default allow and deny lists of omi-next step 3 (`CLAUDE_ALLOWED_TOOLS`,
     `CLAUDE_DENIED_TOOLS` in `worker-launch.ts`), the prompt on stdin and the log
     `omi-NNN-<profile>-<ts>.jsonl` (+ `.err`). Codex: `CODEX_HOME` of the profile,
     `codex exec --json -s workspace-write -m <m> -c model_reasoning_effort=<e> -o
     omi-NNN-codex-last.md [resume <thread>] -`, log `omi-NNN-codex-<profile>-<ts>.jsonl`
     (the tool in the name keeps a Codex log out of a Claude profile's quota reading). Model and
     effort are the `EFFORT_POLICY` entry of the tool for the complexity; they are not options.
     It prints the worker's `exit=N` and returns 1 for a non-zero exit.
  `--dry-run` prints the write and launch commands without writing or launching.
- **`worker-report`** takes the newest `omi-NNN-*.jsonl` and prints the report, the turns, the
  permission denials and the id to resume with. Claude: the longest `result` among the result
  events, with turns, denials and `session_id` of the last one. Codex (a `-codex-` log): the
  `omi-NNN-codex-last.md` text and the `thread_id` of the first line. It exits 1 without a
  report (the worker still runs, or stopped early), still printing the id.
- **`commit-worker`** checks that the checkout is on `<branch>` before it stages anything, runs
  `git add -A -- src tests docs templates schemas`, refuses when nothing is staged or the index
  holds a path outside those directories (for example `.claude/` or `.tmp/`), commits with the
  message on stdin (`git commit -F -`, no `--no-verify`) and prints the SHA.
- **`review-comment`** refuses unless the PR is open and its body names the Issue
  (`Issue: #N`), then checks the comment: the `**VERDICT:** PASS|FAIL · **REVIEWED_HEAD:**
  `<sha>`` line with a head that is the PR head; exactly one
  `AC-<n>: met|not met — <evidence>` line for each top-level AC of the Issue
  (`acceptance-criteria.ts` counts), none extra or repeated; and PASS only with every line met.
  It posts with `gh pr comment --body-file -` only when the local `gh` login is
  `COORDINATOR_LOGIN`. Every reason is listed in one `refused:`.

Boundaries and known limits: `dispatch` does not check whether a worker already runs for the task;
the Claude `exit=` is the shell's view of the worker; `codex exec resume` takes the same `exec`
options before the subcommand, which this tooling has not run against a live Codex.

## Worker prompt packets (OMI-090)

`node tools/coordinator/flow.ts prompt N --step <id> [--worktree <dir>] [--branch <b>]
[--notes <f> | --findings <f>] [--out <f>] [--dry-run]` renders the deterministic worker packet.
The LLM supplies only task-specific judgement in notes/findings. Required --step is the actual
step ID of the Issue's Workflow template, with no aliases; absent steps are refused. All steps
(feature: analyze, implement, verify, review; docs: write/accept; bugfix: reproduce, etc.) resolve
their own role, exactly their step skills and rules, in template order, verbatim. Rule headings
do not invent mandatory status: the file's front matter is authoritative. Runtime role+step
union semantics remain unchanged pending #186.

The shared skeleton is the packaged asset templates/prompts/worker-prompt.md, read
from the configured worker checkout, never a project-editable override. The pure application
service src/application/services/render-worker-prompt.ts validates explicit slots and substitutes
once, so placeholders inside task data stay literal. Tooling may import this application service;
application never imports tools or performs I/O. No new layer/module/dependency is introduced.
Repo-specific restrictions and report content are supplied as slots. Runtime buildPrompt wiring
and JSON/artifact contracts remain #186; broader framework Coordinator dispatch remains #165.

`templates/prompts/` holds package-only assets (architecture §3). Unlike `templates/project/`,
it is never copied into the project's managed files or recorded in the framework lock. Putting
the skeleton under `.omi-squad/` in the installed project templates caused lock-schema rejection
of `worker-prompt.md`. The package's existing `files: ["templates/", ...]` includes the new path;
`tools/check-package.ts` requires the skeleton in the actual archive listing.

The tooling reads the complete Issue body/title, all comments with author/URL provenance and all
Project-item pages for Workflow. Chronological comments are delimited task data; scope-note
candidates are identified without trusting text as approval. extractAcceptanceCriteria reuses
the authoritative acceptance-criteria.ts parser, preserving verdict count/numbering. The full
packet includes workspace/branch, AGENTS.md's design read-first list, notes, exact step content,
restrictions and the Skills applied / Rules applied report contract. The worktree defaults to
OMI_WSL_REPO_DIR, branch to its current branch; detached HEAD requires --branch. Use the same
configured checkout for dispatch. Missing/invalid workflow, step, skeleton or content is refused.

Notes/findings/out paths belong to the calling Coordinator process. Without --out only the packet
is printed to stdout; --out writes only that file. --dry-run renders/previews without writing,
including with --out, and never dispatches a worker. --notes and --findings together are refused.
Findings mode emits only findings, workspace/identity, restrictions and report contract, marked
native-resume-only; dispatch refuses that packet without --resume. A fresh session always gets
the full step packet through --notes.

/omi-next dispatches analyze, QA and review as **fresh independent worker runs**, not review
subagents or a resumed author thread, with no shared author context. A different tool/profile
is not required (PO correction 2026-11-12). Analysis is passed forward as task data; the Coordinator
records the scope-approved decision before implementation, escalating business/cost changes to
the PO. The Coordinator runs flow.ts check on the exact revision; fresh QA judges that recorded
evidence before delivery proceeds. A fresh reviewer judges the same fixed revision, AC and scope
additions, diff and evidence. The Coordinator only posts validated verdicts via review-comment.
Findings return to the implementer's native session (or a full packet for a fresh implementer),
then the new revision needs another script check and fresh QA/review. The 2 + Architect + 2,
exact-head/base, approval, carried-PASS and merge/close gates are unchanged. The developer supplies
the proposed /omi-next edit in .tmp/omi-next-SKILL.proposed.md; the Coordinator applies the protected
native skill edit and verifies it separately.

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

## One watch page for the framework and the repo (OMI-092)

The repo no longer has a page of its own (`tools/coordinator/watch-page.ts` is deleted). `/omi-watch`
serves the framework's page (`src/infrastructure/observability/watch-page.ts`, design in
`docs/design/watch`) through the framework's server (`watch-server.ts`), which keeps every OMI-067
guard: 127.0.0.1 only, Host/Origin checks, hashed CSP without an inline style attribute, `textContent`
and SVG `setAttribute` only, GET-only `/`, `/health`, `/events`. There is no control endpoint: the
page has no probe button and `POST /probe` is a 404. `watch-web.ts` only reads the repo's sources
and `watch-snapshot.ts` maps them into the framework's `WatchSnapshot` contract (source never imports
tools; tools import `src/` through the register hook).

The diagram and its geometry are the framework's: `workflow-diagram.ts` decides node states,
`workflow-diagram-layout.ts` (pure, tested) places nodes, connectors and labels, so a source cannot
draw something different. The repo's own node builders (`diagramNodes`, `templateNodes`,
`compareLoaded`, `orderNodes`) are deleted; `watch-workflow.ts` keeps only the repo-specific part,
mapping what it observes (Project Status, worker, PR verdict) to a template position
(`mapTemplatePos`, `standingOf`). The Issue's template is the only diagram: with no template the
card says "Template unavailable" instead of drawing a lifecycle guess.

**The step of a running worker comes from its prompt header**, `# Workflow <id> · step <step> ·
role <role>`, which `flow.ts prompt` and the interim step script write as the first heading.
`readPrompts` greps that line with the `## Skill:` and `## Rule: <id> (mandatory)` headings (never the
prompt body); `parsePromptText` takes the first valid header only, and a header for another workflow
or a step the template lacks is ignored, as is any header when no worker runs (the prompt file is
overwritten at every dispatch, so it can belong to an older step). With no valid header the step and
role are shown as unknown; nothing is guessed from the lifecycle. A running worker is therefore no
longer drawn as implement when it is the QA or review worker.

Quota is one row per profile in the snapshot (Claude first, then Codex): share left of each window,
the five-hour reset, a severity (`critical` when the limit is reached or a window is under half its
pick-profile threshold, `low` under the threshold) and freshness. A window not read is null and the
page writes "unknown", never 0% or an empty bar. If GitHub fails after a good read the server keeps
the last good cards and flags the board as unavailable.
