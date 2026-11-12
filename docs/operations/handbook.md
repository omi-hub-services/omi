# Operations handbook (v0.1)

Task-oriented guide for the PO and the Coordinator. Everything here was checked against the real
CLI built from this revision (`omi-squad` 0.0.0); the evidence is in [Verification record](#verification-record).
A command that does not exist is marked **not available in v0.1** and is never described as if it did.

Related: [compatibility.md](compatibility.md) (versions and auth modes, the single source for the
compatibility matrix), [packaging.md](packaging.md) (install, update, conflicts, backup restore),
[deploy-runbook.md](deploy-runbook.md), [ADR-0012](../architecture/adr/0012-coordinator-on-windows.md),
[ADR-0020](../architecture/adr/0020-cli-and-ipc.md), [ADR-0030](../architecture/adr/0030-session-runtime-owner.md).

## 0. Read this first

**The executable.** The package is `omi-squad`; its bin is `dist/bootstrap/cli.js`. There is no
command called `omi` on `PATH`. In this handbook `<cli>` means one of:

- WSL2: the project shim `.omi-squad/bin/omi` (created by `install --apply`, see packaging.md);
- Windows: `node '\\wsl.localhost\<distro>\<project>\.omi-squad\bin\omi.cjs'`;
- from a built checkout or extracted package: `node <package>/dist/bootstrap/cli.js`.

Run `<cli>` with the **project root as the working directory**: the socket defaults to
`<cwd>/.omi-squad/local/ipc/runtime.sock`. `--socket <path>` overrides it; `--json` prints one
JSON document `{"schemaVersion":1,"ok":…,"exitCode":…,"result"|"error":…}` for success and failure.

**Where each part runs** (ADR-0012): the Coordinator (Claude Code session) on Windows; the runtime,
SQLite state, workers and the checkout in WSL2 (Linux filesystem, never `/mnt/<drive>`).

**What the v0.1 CLI really has.** `--help` lists: `init`, `install`, `update`, `doctor`, `profiles {register,list,probe}`, `status`,
`session {new,start}`, `approvals decide`, `plan`, `dispatch`, `wait`, `pause`, `resume`, `deliver`,
`coordinator switch`, `new-issue`, `promote`, `set-status` (intake, §9), and `watch`.

| Job            | v0.1 command                                      | Notes                                                              |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| init           | `install`, `init`, `doctor`                       | Preview first; `--apply` creates files (§1)                       |
| login/profiles | `profiles register/list/probe`                    | Login with the native tool (§2)                                   |
| intake         | `new-issue`, `promote`, `set-status`              | Preview first; readiness gate (§9)                                |
| run            | `plan` → `dispatch` → `wait` → `status` → `deliver` | `run` **not available in v0.1** (see §3)                         |
| pause / resume | `pause`, `resume`                                 | §4, §5                                                             |
| retry          | none                                              | `retry` **not available in v0.1** (see §6)                         |
| update         | `update`                                          | §7                                                                 |
| recovery       | `status`, `resume`, `session new`, backups        | §8                                                                 |

Also **not available in v0.1**: `approvals list`, `workflows validate`, `sync` (architecture.md §13).

**Exit codes** (stable, ADR-0020): `0` ok (the command succeeded, not "the task passed"), `1` failure
inside the CLI or runtime (also `install`/`update` conflicts), `2` usage
error (nothing sent), `3` no runtime on the socket or timeout, `4` the runtime refused the request
(`COMMAND_REFUSED`, `NOT_IMPLEMENTED`, …), `5` malformed runtime answer, `6` `DOCTOR_FAILED` (installation checks failed or could not run). Text mode prints errors on
stderr as `error[CODE]: message`.

**First thing to try when anything fails:** `<cli> status --runtime`. Exit 3 means no runtime is running
(start a session, §3). Exit 0 prints `runtime: ready`, `version: …`, `started: …`.

### Status and watch

`<cli> status [--project <path>] [--json]` reads the existing
`.omi-squad/local/state/state.sqlite` in read-only mode alongside live GitHub Project and PR
reads. It groups open non-Epic tasks by Status, lists PR checks and the latest runtime-recorded
review (a review of another head is `stale`), running attempts, profile quota and the next
unblocked Ready task in priority/milestone/Issue order. JSON follows the envelope above; the
report is in `result`. Without quota configuration it reports `null`; missing readings are
`unknown`, never zero. These views never request a paid quota probe.

`<cli> watch [--project <path>] [--port 4381] [--interval 5]` prints a URL to open in the
browser. Port `0` chooses an available port; interval is positive seconds. It binds only
`127.0.0.1`, validates Host and Origin against its own port, and streams updates over SSE.
Polling starts with the first SSE client; loading the page or health endpoint does not start it.
Runtime state refreshes at the requested interval. GitHub board reads are cached for at least
60 seconds; a failed refresh keeps the last good titles and blockers and marks GitHub unavailable.
It exits 60 seconds after the last SSE client leaves (also if none connects), or on Ctrl-C.
It has no control or probe endpoint. An occupied port fails; choose another with `--port`.

Each active run has a diagram from its pinned workflow hash and latest runtime steps, attempts
and quality controller: template steps/gates, Review → Developer rework, Architect after two
quality failures and Ask PO after the assisted budget is spent. Blocked dependencies/runtime
blocks and Waiting PO approvals are shown at the held step when no worker runs. Template
skills/rules and the worker's recorded loaded skills/rules are shown separately. Gate colours
indicate progress of their adjacent step; they are not approval evidence or authority to merge.
Before the first successful GitHub read, cards remain visible without titles/blockers. If the pinned
template is no longer in the catalog, the card says so and has no diagram; no fixed lifecycle is
substituted. Failed snapshot reads display a fixed unavailable message and retry.

Both commands default to the current project directory and need an initialized project and an
existing migrated state DB; they never create or migrate one. `status` fails if GitHub cannot
be read, rather than reporting an empty board. To inspect runtime connectivity without project
configuration, use `status --runtime [--socket <path>]`; `status --run <id>` retains the IPC run
view. Watch displays recorded runtime state; it does not scan processes to prove OS liveness.

## 1. Init

**Install the framework into a project.** Preview first, then apply
the same arguments. Details, Windows invocation and the bootstrap archive are in packaging.md.

```sh
node <package>/dist/bootstrap/cli.js install --project /home/user/project --package <package> --distribution Ubuntu-24.04
node <package>/dist/bootstrap/cli.js install --project /home/user/project --package <package> --distribution Ubuntu-24.04 --apply
<cli> doctor --project /home/user/project --distribution Ubuntu-24.04
```

- `install` without `--apply` writes nothing and prints `preview: <version>; changes: <template paths>`.
  `bridge/skill/*` targets `.claude/skills/omi-squad/`; `bridge/CLAUDE.md` and `bridge/AGENTS.md`
  identify marked spans in the root instructions. The preview includes all bridge targets.
- `--apply` backs up, installs the package under `.omi-squad/tool/`, and writes the shims and templates.
- `doctor` prints `WSL2 installation checks passed` (exit 0) or `error[DOCTOR_FAILED]: <check>: <detail>; …`
  (exit 6) naming each failed check (`interop`, `distribution-version`, `windows-launch`, …).
- The installer creates the skill, `bridge.ts`, and a bound `bridge.config.json`. It appends one
  `<!-- omi-squad:start -->` / `<!-- omi-squad:end -->` span to each instruction file. Existing
  user text outside the span is preserved; local edits inside the span or skill follow the same
  three-way conflict rules as templates. Malformed/duplicate markers and symlink targets are refused.

When it fails:

| Symptom                                           | Meaning / action                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `INVALID_INSTALLATION_TARGET`                     | The project is the framework source repo or inside it, under `/mnt/<drive>`, a symlinked path, or inside the package dir. Use a project on the Linux filesystem outside this repository. |
| `UNMANAGED_TOOL_INSTALLATION`                     | `.omi-squad/tool`, `bin/omi` or `bin/omi.cjs` exists without a framework lock. Remove or move it yourself; the installer will not overwrite it. |
| `Template conflicts: <paths>`                     | See §7.                                                                                                   |
| `doctor` fails on `interop` / `distribution-version` | Run it from WSL2 with Windows interop enabled and the distro registered as WSL 2 (`wsl.exe --list --verbose`). |

**Create the project configuration with `init`.** Supply a JSON baseline matching
`schemas/project-config.v1.schema.json`, for example `baseline.json`:

```json
{
  "schema_version": 1,
  "repository": { "owner": "acme", "name": "app" },
  "project": { "owner": "acme", "number": 4 },
  "branches": { "integration": "develop", "release": "main" },
  "limits": { "max_parallel_workers": 2, "step_timeout_seconds": 600, "max_rework_cycles": 2 },
  "effort_policy": { "low": "low", "medium": "medium", "high": "high" },
  "policies": { "mandatory_approvals": ["release", "deploy"], "github_approval_actors": ["your-po-login"] }
}
```

```sh
<cli> init --project /home/user/project --config /home/user/baseline.json --variant existing
<cli> init --project /home/user/project --config /home/user/baseline.json --variant existing --apply
```

`--variant new` chooses the empty-repository workflow; `existing` is the default. Preview writes
nothing, including directories. Apply creates `.omi-squad/config/project.yaml`, the onboarding
workflow, `config/codebase.yaml`, and `config/onboarding-plan.md`. Every existing file is kept,
including user comments; repeating apply is safe. Init never contacts GitHub or executes detected
commands. Invalid baseline/path/variant returns exit 2 without echoing the input. Existing-project
mapping and Project-template copy use cases remain outside this local CLI path (ADR-0029).

Configure project-owned `.omi-squad/config/models.yaml` with verified aliases, capability profiles,
and `verified_models` before starting the runtime (schema: `models-config.v1.schema.json`). Init does not
guess model capabilities. Start/restart the managed session after configuration changes. The runtime
now passes the `PROJECT_NOT_CONFIGURED` gate; missing imported tasks, models, profiles or approvals
can still refuse plan/dispatch with their own typed reasons.

## 2. Login (profiles)

**Login uses the native tools; `profiles` registers and probes their metadata.** Logins are done on the
side that uses them, and never shared (ADR-0012 §4, ADR-0031):

| Side                       | Who uses it  | Directory (convention)                         | Native step                                                        |
| -------------------------- | ------------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| Windows                    | Coordinator  | Claude Code's normal Windows login             | Log in to `claude` on Windows as usual                              |
| WSL2, one per account      | Claude worker| `CLAUDE_CONFIG_DIR=~/.claude-profiles/<id>`    | `CLAUDE_CONFIG_DIR=… claude` then `/login` (interactive)            |
| WSL2, one per account      | Codex worker | `CODEX_HOME=~/.codex-profiles/<id>`            | `CODEX_HOME=… codex login` (ChatGPT subscription, file store)       |

Rules: subscription logins only (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`OPENAI_API_KEY`, `CODEX_API_KEY` are unsupported, see compatibility.md); one directory per account;
never copy or mount a profile directory across the Windows/WSL boundary (rotating refresh tokens
would invalidate each other); several directories of one account share one quota.
The adapters read a profile with `claude auth status --json` / the Codex file store; the status is
`ready`, `login-required` or `unsupported-auth-mode`. A `LOGIN_REQUIRED` failure stops the step; the
runtime does not retry it. Fix: log in again with the native tool.

With the managed runtime running (§3), register each native profile, then probe it:

```sh
<cli> profiles register worker-a --tool claude-code --profile-home /home/user/.claude-profiles/worker-a --account-group account-a --model <verified-native-model>
<cli> profiles list
<cli> profiles probe worker-a
```

For Codex use `--tool codex` and the directory used as `CODEX_HOME`. Repeat `--model` for each
verified native model. The registry stores metadata in SQLite, starts at `unknown`, and a successful
probe updates readiness. Registration defaults: one worker per profile/account group, 5-minute probe
TTL, preference 0. A duplicate ID refuses `PROFILE_EXISTS`; registration does not reset cooldown or
disabled state. Only one Codex profile is supported. List/probe/register use the runtime socket,
so no session returns exit 3. Probing unknown IDs refuses `PROFILE_NOT_FOUND` (exit 4).

Probes reuse ADR-0023: Claude native status, Codex bounded in-memory auth-mode validation. Tokens are
never stored, printed, logged or copied, and auth files are never written by the framework. Probes
do not make model calls, measure quota or expand the model allowlist. Native login itself remains
unverified here; tests use fake executables and synthetic profile caches.

## 3. Run

A run is driven by the Coordinator through these commands, in order. All need a running runtime and
a configured project (§1).

1. **Start the session (Windows, foreground).** Starts the WSL runtime, then the Coordinator:

   ```text
   node <package>\dist\bootstrap\cli.js session start --project /home/user/project --runtime /home/user/project/.omi-squad/tool/node_modules/omi-squad/dist/bootstrap/runtime.js --distribution Ubuntu-24.04
   ```

   Flags: `--project`, `--runtime` (absolute Linux paths, both required), `--distribution`,
   `--coordinator <executable>` (default `claude`). `--socket` is refused. Ctrl-C or Coordinator exit
   stops the runtime and prints `Session stopped`. A failed or unconfirmed stop prints
   `error[INTERNAL_ERROR]: session failed or runtime stop was not confirmed` (exit 1); then check that
   no runtime/worker process is left before starting again. A second runtime for the same project is
   refused (one project owner).
2. `<cli> plan --issue <number> [--workflow <id>]` starts a run for an **imported** Issue.
3. `<cli> dispatch --run <id> --step <id>` sends one **ready** step to a worker.
4. `<cli> wait --run <id> [--timeout <1-3600>]` blocks until no worker of the run is running
   (default 300 s). Use it instead of polling.
5. `<cli> status --run <id>` shows the run and its steps; `status --runtime` shows the runtime.
6. `<cli> deliver --run <id> --pr <n> --head-sha <sha> --check <name> [--check …] [--min-approvals <n>]`
   merges the reviewed head into `develop` and closes the task. `--head-sha` must be the head the
   independent review examined; at least one `--check` is required.

Refusals print `error[COMMAND_REFUSED]: <REASON>[: detail]` (exit 4). Reasons seen in the code
(not all reproduced live, see the record): `PROJECT_NOT_CONFIGURED`, `INVALID_INPUT`, `WORKFLOW_REQUIRED`,
`WORKFLOW_UNKNOWN`, `TASK_NOT_FOUND`, `WORKFLOW_CYCLIC`, `RUN_NOT_FOUND`, `RUN_NOT_RUNNING`,
`STEP_NOT_READY`, `NOT_PLANNABLE`, `STATE_REJECTED`, `TASK_NOT_READY` (the Issue fails the readiness
gate, §9: `dispatch` creates no branch, attempt or worker). A usage error (exit 2) means a missing/invalid
flag; numbers must be whole (`--issue 1`, not `1e3`). Exit 3: no runtime, start the session.
Merge and PO-approval gates are in [ADR-0034](../architecture/adr/0034-task-pr-merge-gates.md); an
`approvals decide` uses the runtime approval composition:

```sh
<cli> approvals decide <request-id> --expected-version 0 --decision approved --github-comment <numeric-id>
```

The owning workflow creates the request and supplies its ID/version/hash. GitHub evidence must be
an unedited human `User` comment in the configured repository, authored by a login in
`policies.github_approval_actors`. Its strict JSON body contains `schemaVersion: 1`, `approvalId`,
`subjectHash`, `version`, `decision`, and optional `reason`. Rejections require matching `--reason`.
Without `--github-comment`, the runtime requires a fresh exact confirmation on its own TTY;
supervised/headless runtimes use GitHub. There is no agent-text or `--yes` approval source.
Refusals use `APPROVAL_REFUSED` (exit 4), including `SOURCE_NOT_AUTHENTICATED`, `ACTOR_NOT_ALLOWED`,
`GITHUB_COMMENT_EDITED`, `STALE_VERSION`, and `STALE_REVISION`.

The shipped subject reader resolves business requests against the current imported task snapshot
(`subjectId` = task ID, baseline = `content_hash`, scope = that task). Re-import a changed revision
before approval; requests pin that revision. Cost/release/deploy require their owning workflow's
authoritative subject reader and fail closed when unavailable. No subject is inferred from agent
claims or copied from the approval request.

## 4. Pause

```sh
<cli> pause --run <id> --reason "<why, 1-500 chars>"
<cli> pause --run <id> --reason-stdin      # reason read from stdin; use for text from a script
```

Exactly one of `--reason` / `--reason-stdin` (otherwise `error[USAGE]: give exactly one of --reason and --reason-stdin`).
The runtime stops the run's workers, writes a checkpoint and marks the run paused. Failures:
`RUN_NOT_FOUND`, `RUN_NOT_PAUSABLE` (the run is not in a pausable state), `CHECKPOINT_FAILED`,
`STATE_REJECTED`, `PROJECT_LOCK_LOST` (this session lost project ownership: stop the session and
start a new one, §8).

Pause everything before changing Coordinator: `<cli> session new` (end this Coordinator session
cleanly) or `<cli> coordinator switch --to <profile-label>`. Both **only** checkpoint and pause active
runs; relaunching the Coordinator and changing its login stay manual (ADR-0030 decision update).
`coordinator switch` needs a non-empty `--to`; failures: `PROFILE_REQUIRED`, `PAUSE_FAILED`.

## 5. Resume

```sh
<cli> resume --run <id>
```

Resumes a paused or interrupted run from its newest intact checkpoint: it verifies the checkpoint,
the worktree (head, branch, dirty state, file hashes), reconciles GitHub, re-checks the gates, then
starts a **fresh attempt** of the interrupted step. Success prints the new `attemptId` / `stepRunId`.
It never stashes, resets or cleans anything.

When it is refused (`error[COMMAND_REFUSED]: <REASON>`), the workspace is left as it is:

| Reason                                                                | What to do                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `RUN_NOT_FOUND`, `RUN_NOT_RESUMABLE`                                  | Check the id and state with `status --run <id>`; only paused/interrupted runs resume.            |
| `CHECKPOINT_MISSING`, `CHECKPOINT_INVALID`                            | The checkpoint files are missing, altered or inconsistent. Keep them for diagnosis; ask the PO. |
| `WORKSPACE_UNAVAILABLE`, `GIT_MISMATCH`                               | The worktree is gone or its head/branch changed since the checkpoint. Do not force it; ask the PO. |
| `UNCOMMITTED_MISMATCH`, `UNCOMMITTED_UNVERIFIABLE`, `ARTIFACT_HASH_MISMATCH` | Local files differ from, or cannot be matched to, the checkpoint. Resolve explicitly (commit, keep or discard by hand), then retry. |
| `GITHUB_UNRESOLVED`, `GATE_INVALID`                                   | The remote outcome is unknown, or an approval/check gate no longer holds. Fix the gate, retry.   |
| `NO_READY_STEP`, `DISPATCH_FAILED`, `STATE_REJECTED`                  | Inspect `status --run <id>`; a partial recovery can be retried with the same command.            |
| `PROJECT_LOCK_LOST`                                                   | Start a new session (§8).                                                                       |

A run is not Done after resume; the normal review/delivery gates still apply.

## 6. Retry

**`retry` is not available in v0.1**, as recorded in architecture.md §13. What exists:

- Infrastructure failures (rate limit, network, a dead worker process) follow the built-in bounded
  retry policy inside the runtime; nothing to run. Login and invalid-config failures stop instead
  (`LOGIN_REQUIRED`, `INVALID_CONFIG`) and need a human fix.
- `dispatch --run <id> --step <id>` works only for a **ready** step of a **running** run
  (`STEP_NOT_READY` / `RUN_NOT_RUNNING` otherwise). It does not reopen a failed or blocked step: failed
  steps keep the PO's retry/rework authorization boundary, and no command records that decision yet.
- A terminal attempt never restarts; "retry" is always a new attempt (ADR-0030).

## 7. Update

```sh
node <new-package>/dist/bootstrap/cli.js update --project /home/user/project --package <new-package> --distribution Ubuntu-24.04
node <new-package>/dist/bootstrap/cli.js update … --apply
```

`update` takes the same flags as `install` and shares its implementation. Stop the managed session
first (live or unreconciled owner leases refuse the update). The preview prints
`preview: <version>; changes: <paths>` or lists conflicts and changes nothing; `--apply` takes a SQLite
backup and a backup of config/templates/shims first.

Conflict (`error[INTERNAL_ERROR]: Template conflicts: <paths>`, exit 1): you and the new version both changed
a file. Make the local file equal to the incoming version, or restore the old base, then retry. Keep
custom content separately before taking the upstream file. Files outside the template manifest are yours
and untouched. Project, distro and location cannot be changed by an update. The full rules and
the manual restore after an interrupted publish are in packaging.md.

## 8. Recovery

| Situation                                    | Do this                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Unsure what is running                       | `<cli> status` (`--json` for machines): runtime state, active attempts and runs.                              |
| Coordinator closed, crashed or lost the pipe | The runtime stops dispatching, interrupts workers and releases ownership. Start `session start` again.        |
| Runtime refuses to start (owner exists)      | Another runtime owns the project; stop it. A crashed owner's lease expires (60 s) and is then reclaimed.      |
| A run was interrupted                        | `status --run <id>`, then `resume --run <id>` (§5).                                                           |
| Switching Coordinator account/session        | `session new` or `coordinator switch --to <label>`, then start a new session and `resume` each run.           |
| Failed `update`/`install`                    | The old tool and files stay active on SQL or provisioning failure. Backups: `.omi-squad/local/backups/`; restore by hand as in packaging.md. |
| Worker may still be writing                  | Do not reuse its worktree because a lease expired: prove the process is gone first (ADR-0030).               |

Safety rules: never delete `.omi-squad/local/state/` or the worktrees to "reset" a run; never copy
native modules from Windows; backups are local, not disaster recovery. The runtime backs up SQLite
before pending migrations.

## 9. Intake: new Issue, readiness gate, promote

Three commands put work on the GitHub Project and move it into the queue. They talk to GitHub
directly (the `gh` login of the machine), not to the runtime, so no session is needed. All take
`--project <path>` and read the repository and Project from `<path>/.omi-squad/config/project.yaml`
(`PROJECT_NOT_CONFIGURED` otherwise). Preview and refusals write nothing.

**The readiness gate** (pure, one implementation for all three commands and for `dispatch`). A task
is ready only when: its Project `Plan Key` is `PREFIX-NNN` and matches **exactly one**
`<!-- omi-squad:plan-key=… -->` marker in the Issue body; Priority, Work Type, Workflow, Role and
Area are all set; and `## Acceptance criteria` has at least one **top-level** checkbox (nested
checkboxes, checkboxes in a code fence and anything under a `###` sub-heading do not count; this
is the same parser that ticks the criteria at delivery). A refusal lists every failed condition at once.
The gate runs on a move to Ready or In Progress (`promote`, `set-status`) and before `dispatch`
creates a task branch.

```sh
<cli> new-issue --project <path> --file spec.md [--prefix OMI]          # preview
<cli> new-issue --project <path> --file spec.md [--prefix OMI] --apply  # create
<cli> promote [<issue>] --project <path> [--dry-run]
<cli> set-status <issue> "Ready"|"In Progress" --project <path>
```

- **`new-issue`** reads a Markdown spec that starts with YAML frontmatter (all keys required,
  unknown keys refused): `title`, `priority`, `workType`, `workflow`, `role`, `area`, `milestone`
  (exact title), `epic` (number of an existing Epic) and `blockedBy` (list of Issue numbers, may be
  empty). The body needs `## Mục tiêu`, `## Phạm vi`, `## Acceptance criteria` (one top-level
  checkbox at least) and `## Dependencies`. Without `--apply` it prints the allocated key
  (largest existing `PREFIX-NNN` over Issue markers, title prefixes and Project values, closed
  Issues included, plus one; pull requests and Epic keys do not count), title, milestone, epic,
  blockers and field values, and writes nothing. `--prefix` is the project's Plan Key prefix
  (default `OMI`; `project.yaml` does not carry it yet). Values must match the live Project options.
  With `--apply` it first **saves the marker into the spec file**, then creates the Issue with its
  milestone, adds it to the Project, sets Priority, Work Type, Workflow, Role, Area, Status
  `Backlog` and Plan Key, and attaches the epic (sub-issue) and the native blocked-by Issues.
  Creating an Epic is refused. Keep the spec for a retry: when its marker is already on an Issue
  the command prints `done: … exists on #N` and creates nothing. The writes are **not atomic**: if a
  later write fails the Issue exists, the command exits 1, and you finish the Project fields or
  relationships by hand. Do not delete the marker and retry. Run one creation at a time (the key is
  read, then written; there is no lock).
- **`promote [<issue>]`** moves a Backlog task to Ready only when every native blocker is closed
  (more blockers than were read counts as blocked) and the gate passes; an Epic, a closed Issue or a
  task not in Backlog is refused, an already Ready one prints `done:`. Without `<issue>` it takes the
  first eligible Backlog task by Priority, then milestone title (no milestone last), then Issue
  number; when none qualifies it prints `none: …` and exits 0. `--dry-run` prints the pick and writes
  nothing.
- **`set-status <issue> Ready|"In Progress"`** applies the gate and then sets the Project Status. A
  task already at that status still has to pass the gate. Other statuses are refused as a usage
  error: this command is not a way around the gates of the rest of the delivery flow.

Exit codes: `0` success (including `done:`/`none:`/preview), `4` refused (`error[COMMAND_REFUSED]:`
followed by all reasons), `2` usage (bad number, status or prefix, missing flag), `1` GitHub or
configuration failure (`error[INTERNAL_ERROR]: Issue intake failed: <CODE>` or `Task board
operation failed: <CODE>`, for example `HTTP_403`, `INVALID_RESPONSE`, `STATUS_OPTION_MISSING`).
`--json` gives the result document with `kind` (`preview`, `created`, `exists`, `promoted`, …).

Limits: these commands were exercised against an in-memory fake GitHub (contract tests), **not**
against live GitHub, so the first live run should start with a preview / `--dry-run`. The Coordinator's
`tools/coordinator/` scripts keep doing the same job for this repository until `omi` replaces them
(ADR-0014); the framework does not import them.

## Compatibility matrix

Versions, auth modes and their evidence are in [compatibility.md](compatibility.md); a version not
listed there is `untested`. This table adds only what the CLI itself depends on:

| Area                                     | Status in v0.1                  | Evidence                                                                 |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| WSL2 Ubuntu, Node 24, Linux filesystem   | supported (see compatibility.md)| `npm run check`; CLI check in the record below                           |
| `status`, usage/exit codes, runtime start/stop in WSL2 | checked 2026-11-12 | record below (throwaway project, fake GitHub/native CLI; no live worker) |
| `install`/`update` preview                | checked 2026-11-12             | record below                                                              |
| `install --apply` with real npm provisioning, clean WSL2 | untested        | packaging.md (offline tests only)                                         |
| Windows launcher, UNC shim, `session start`, `doctor` interop | untested   | ADR-0030 limits; `doctor` fails without WSL interop (checked)             |
| Run commands against a configured project, real GitHub | untested here       | configured gate/refusal checks below are offline; see ADRs for live evidence |
| Windows 11 Coordinator                   | untested                        | compatibility.md                                                          |

## Known limitations

- No `login`, `run`, `retry`, `approvals list`, `workflows validate`, `sync`.
- Init uses local onboarding; GitHub Project mapping/template copy still has no CLI.
- Init needs an explicit baseline; models and task import remain project/workflow configuration.
- `session` has no `stop`: Ctrl-C on the foreground launcher (or closing the Coordinator) is the stop.
  `session stop --help` prints the `session` help.
- Codex: one profile; no Codex-to-Codex failover. Per-model limits are seen only after a rejection.
- Windows graceful shutdown, sleep/hibernate and `wsl --shutdown` paths are unverified (ADR-0030).
- Version `0.0.0`, local tarball only; no registry publication.

## Folder rules (a project that uses omi-squad)

| Path in the project                                                                 | Git      | You may edit?                                                    |
| ----------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `.omi-squad/config/project.yaml`, `models.yaml`                                      | tracked  | Yes, the project owns them; no credentials in them              |
| `.omi-squad/workflows/`, `roles/`, `rules/`, `skills/`, `provenance/`               | tracked  | Yes, but a local edit can conflict with `update` (§7); keep a note of why |
| `.omi-squad/framework.lock.json`, `.omi-squad/bin/`, `.omi-squad/tool/package*.json`, retained tarball | tracked | **No**: installer-managed; change only through `install`/`update` |
| `.omi-squad/tool/node_modules/`                                                      | ignored  | **No**                                                           |
| `.omi-squad/local/` (`state/`, `runs/`, `profiles/`, `credentials/`, `ipc/`, `locks/`, `tmp/`, `backups/`) | ignored | **No**: runtime state, checkpoints, logs, sockets; never commit or paste into prompts, Issues or PRs |
| Task worktrees (a sibling directory outside the checkout)                           | n/a      | **No**: workers own them; the Coordinator changes code only through workers and PRs |
| Native `~/.claude*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` profile directories           | n/a      | Only through the native tools' own login; the framework does not edit native config |

Ignore `.omi-squad/local/` and `.omi-squad/tool/node_modules/` in the project's Git setup (packaging.md).
The framework source repository is separate: never install or run omi-squad inside it
(`INVALID_INSTALLATION_TARGET`), and keep temp/debug output in `.tmp/` (AGENTS.md §5).

## Verification record

Checked on 2026-11-12 after `npm run build`, using the real `dist/bootstrap/cli.js` and runtime
from an extracted local package, in a throwaway project under `.tmp/omi-076-cli-*/project/`.
The local smoke script recorded 38 CLI invocations and 48 passing assertions. The package fixture
omitted dependencies to exercise real npm provisioning offline; imports used the checkout's existing
dependencies. This does not prove a clean installation of the full dependency tree. Native probes
and GitHub read-back used fake executables and synthetic data; no real profile or GitHub was touched.

| Command                                                                 | Observed                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `--help`, plus help for init/install/update/doctor/profiles (all three subcommands), approvals decide, plan/dispatch/wait/status/pause/resume/deliver, session/start/new, coordinator switch | exit 0; flags as documented |
| `run --issue 1`, `retry --task task`                                    | exit 2 `USAGE`, unknown command |
| `install` preview                                                     | exit 0 `preview`; project remains empty; bridge paths included |
| `install --apply`, repeated after adding user instruction text         | exit 0 `installed`; skill, bridge.ts, bound config created; one marker span; user text kept |
| `init --project … --config baseline.json`                              | exit 0 `preview`; project.yaml absent |
| `init … --apply`, repeated                                            | exit 0 `applied`; config created, then reported kept |
| `doctor` in this sandbox                                               | exit 6 `DOCTOR_FAILED`; interop, distribution-version, windows-launch unavailable |
| `status --json` (runtime up)                                           | exit 0 `state: ready` |
| `plan --issue 999 --workflow onboarding-takeover`, `dispatch --run missing --step implement` after init | exit 4 `TASK_NOT_FOUND` / `RUN_NOT_FOUND`; no `PROJECT_NOT_CONFIGURED` |
| `profiles register`, `profiles list`, `profiles probe`                  | exit 0; registered unknown, listed metadata, fake native probe ready |
| `approvals decide …` without a runtime TTY                             | exit 4 `APPROVAL_REFUSED: SOURCE_NOT_AUTHENTICATED` |
| `approvals decide … --github-comment 42` with exact allowlisted fake evidence | exit 0 `approved`, verified `github-actor` provenance persisted |
| runtime stop (`stop` on stdin)                                          | runtime process exit 0                                                       |

Integration tests additionally cover init byte preservation and source-path refusal, real runtime
registration/probes for both tools with fake executables and unchanged synthetic auth bytes, and
approval rejection for bot, unallowlisted, edited or unauthenticated sources. Packaging e2e tests
cover instruction backups, local overrides, update merging, malformed markers, symlinks and previews.

The intake commands of §9 are not in this record: they were checked by unit, integration and
contract tests with a fake GitHub only.

Not run live: native login/probes, GitHub approval, runtime TTY confirmation, Windows `session start`,
full-dependency clean npm installation, and successful worker/delivery flows. These remain opt-in
platform acceptance; the smoke record is offline CLI evidence.
