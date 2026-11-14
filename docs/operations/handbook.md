# Operations handbook (v0.1)

Task-oriented guide for the PO and the Coordinator. CLI syntax was reconciled against the built `omi-squad` 0.0.0; current offline evidence and
explicit live exclusions are in [CLI verification](cli-verification.md). Earlier smoke evidence
is retained in [Verification record](#verification-record), dated separately.
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
`session {new,start}`, `approvals {list,request,decide}`, `workflows validate`, `plan`, `run`, `dispatch`, `wait`, `pause`, `resume`, `deliver`, `merge-release`,
`coordinator switch`, `new-issue`, `promote`, `set-status` (intake, §9), `watch`,
`worker-report`, `commit-worker`, `review-comment`, `import-task`, `sync`, and `prune-logs`.

| Job            | v0.1 command                                      | Notes                                                              |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| init           | `install`, `init`, `doctor`                       | Preview first; `--apply` creates files (§1)                       |
| login/profiles | `login`, `profiles register/list/probe`           | Login with the native tool; `login` shows the step and probes (§2) |
| intake         | `new-issue`, `promote`, `set-status`              | Preview first; readiness gate (§9)                                |
| run            | `run`, or `plan` → `dispatch` → `wait` → `status` → `deliver` | `run` = plan + first dispatch, same gates (see §3)       |
| pause / resume | `pause`, `resume`                                 | §4, §5                                                             |
| retry          | `omi retry --run <id> --step <id> [--po-decision <id>]` | New attempt through rework/failover and approval gates (see §6) |
| update         | `update`                                          | §7                                                                 |
| recovery       | `status`, `resume`, `session new`, backups        | §8                                                                 |

### Sync GitHub and the outbox

```text
<cli> sync
<cli> sync --issues 235 236 --json
```

Run this against an active session runtime. IPC command `sync` has `schemaVersion: 1` and
runs under the runtime's single-writer project lease, using the same GitHub adapter as recovery
and delivery. It reads unknown outcomes by operation marker first, flushes only operations
already queued in the outbox, then imports the explicit Issue selection through the same path
as `import-task`. It creates no new GitHub write intent. Without `--issues` it imports nothing;
there is no import-all option. Existing batch size, retry budget, jitter, backoff and Retry-After
still apply; another call continues the remaining queue.

Text output lists each reconciled operation and flush attempt, then imported task IDs and
`content_hash`. JSON includes a versioned `result` with `reconcile.entries`, `attempts`,
`snapshots` (`taskId`, `contentHash`, `outcome`) and `githubUnavailable`. Reconciliation outcomes
are `succeeded`, `pending`, `waiting`, `unavailable`, `deferred`, `stale` or `unreadable`;
flush attempts preserve the outbox's `succeeded`, `rejected_retry`, `failed`, `outcome_unknown`,
`gave_up` or `skipped` outcomes. `waiting` retains the grace period and `stale` means another
transition won; neither permits a blind resend.

A failed GitHub read stops flushing and leaves later unknown operations `deferred`. Rate limits
stop the pass and preserve the retry schedule. Import is skipped in both cases. Exit `4` with
classification `GITHUB_UNAVAILABLE` or `RATE_LIMITED` identifies these incomplete passes; their
JSON error envelope retains `result` so partial operation results remain visible. A failed
requested import also keeps the completed flush report. Exit `0` means the pass completed;
inspect waiting/stale/failed/unknown outcomes and `stopped` before deciding whether work remains.
A second pass does not resend succeeded operations, and unchanged snapshots keep their hashes.
Changed Issue content updates the business baseline, making an old approval stale under the
existing policy; sync never requests, decides or rewrites an approval. An import that changes a
task's hash marks that task's open (`pending` or `approved`) business approvals `invalidated`
(`approvals list --status invalidated`); the recorded decision stays for audit. `dispatch`,
`resume`, `retry` and failover re-read the current hash and refuse an approval for an older
revision with `BUSINESS_APPROVAL_STALE` before any branch, worktree or attempt exists. Request and
decide a new business approval for the re-imported revision to continue. A paused run whose Issue
changed continues the same way (§5): `resume` accepts the new baseline only with a current approval.

**Exit codes** (stable, ADR-0020): `0` ok (the command succeeded, not "the task passed"), `1` failure
inside the CLI or runtime (also `install`/`update` conflicts and workflow validation errors), `2` usage
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
  (exit 6) naming each failed check (`interop`, `distribution-version`, `windows-launch`, `session-runtime-launch`, …). `session-runtime-launch` fails when the project
  shim cannot start Node.js (for example nvm removed): rerun `install --apply` with a working Node.js
  or put `node` on PATH; `session start` reports `RUNTIME_START_FAILED` for the same cause.
- Install/update records worker CLI directories from its WSL PATH and the shim prepends them
  and Node's directory for the runtime and workers. Native `~/.local/bin/claude` and nvm npm
  `codex` work without a login shell. After moving/installing a CLI or removing an nvm version,
  stop the session, apply install/update from a WSL shell where the replacements are on PATH,
  then restart. This changes only the shim's process environment, without sourcing shell rc.
- `doctor` checks `worker-cli-claude` and `worker-cli-codex` through the same `wsl.exe --exec`
  shim environment as runtime launch. A CLI that works only in your current shell fails its
  named check; follow its `fix`. `profiles probe` and `login` include a `diagnostic` explaining
  missing or unrunnable CLIs and the install/update remedy.
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
| `doctor` fails on `interop`                       | No enabled `WSLInterop*` entry in `/proc/sys/fs/binfmt_misc/` (`WSLInterop` or `WSLInterop-late`) or `WSL_INTEROP` is not accessible. Enable `[interop] enabled = true` in `/etc/wsl.conf` and restart the distro. |
| `doctor` fails on `wsl-exe`                       | `wsl.exe` is on neither PATH nor `/mnt/c/Windows/System32`. Set `[interop] appendWindowsPath = true` in `/etc/wsl.conf` (then `wsl.exe --shutdown`) or add `/mnt/c/Windows/System32` to PATH. `distribution-version` and `windows-launch` then fail only as "cannot be checked"; fix `wsl-exe` first. |
| `doctor` fails on `distribution-version`          | `wsl.exe` ran but the distro is not WSL 2. Run `wsl.exe --set-version <distro> 2`. |

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
  "policies": { "mandatory_approvals": ["release", "deploy"], "github_approval_actors": ["your-po-login"] },
  "checks": { "project-check": { "command": ["npm", "test"], "timeout_seconds": 600 } }
}
```

`checks.project-check` is required for the feature, bugfix and refactor workflows. Workers have no
shell, so the runtime runs it in the task worktree after `implement` and again at `verify`. A pass
makes the step succeed even though the worker never ran the tests; a failure fails the step and its
output is kept as evidence. `command` is an argv array (no shell). Without it every dispatch of
those workflows is refused with `CHECK_UNCONFIGURED`, and `workflows validate` (run it in a project
that has `config/project.yaml`) reports `step "implement" requires check "project-check" but
project.yaml has no checks.project-check`.

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

Init/install supplies `.omi-squad/config/models.yaml` with Claude Code (`claude-sonnet-5-5`,
`claude-opus-5-5`) and Codex (`gpt-6.1-sol`) defaults for the workflow capability profiles.
Existing project edits are preserved by init and the installer's three-way merge; divergent
upstream/local changes report a conflict before writing. The runtime
now passes the `PROJECT_NOT_CONFIGURED` gate; missing imported tasks, models, profiles or approvals
can still refuse plan/dispatch with their own typed reasons.

### Change models

Edit the project-owned `.omi-squad/config/models.yaml` (schema: `models-config.v1.schema.json`).
Under `models`, change the CLI `model` ID and its verified `supported_efforts`, keeping the correct
`executor` (`claude-code` or `codex`). Keep the capability profile IDs referenced by workflows
(`analysis`, `coding`, `testing`, `review`); `min_effort` is a floor, while task/step policy chooses
the effort. Update each profile's `verified_models` alias list when adding/removing aliases.
Only list models and efforts available to your subscription, and register ready worker profiles
whose model allowlists include those CLI IDs (see Login below). The catalog supplies no login or
quota. Start/restart the managed session after configuration changes so the runtime reloads them.

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

`<cli> login <profile-id> [--json]` is a shortcut for the daily check: it looks the registered profile
up, prints the exact native step (`CLAUDE_CONFIG_DIR=<home> claude` then `/login`, or
`CODEX_HOME=<home> codex login`), probes it, and reports `ready`, `login-required` or `unavailable`
(a disabled, cooling-down or stale profile counts as unavailable). Exit 0 only when ready, exit 4
otherwise or for an unknown profile (`PROFILE_NOT_FOUND`). It starts no login, reads no credential file
and prints only the profile directory path; run the native step yourself, then run `login` again.

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
2. Import the Issues, then plan a run:

   ```sh
   <cli> import-task 142 144
   <cli> approvals request task-142 --kind business
   <cli> plan --issue 142 --workflow feature
   ```

   `import-task <issue-number> [issue-number ...]` sends `task.import` over runtime IPC.
   Repository and Project come from `project.yaml`. Run from the installed project, or select
   its runtime with `--socket <path>`. Each result prints the local task id,
   `content_hash=<sha256>` and `stored`/`unchanged`; `--json` returns `snapshots` with `taskId`,
   `contentHash` and `outcome`. Unchanged hashes write no duplicate import event; edited Issues
   replace their stored baseline. Native dependencies are imported too. Missing, closed, archived
   or off-Project selected Issues are refused before snapshot writes. The runtime registers or
   reuses the local project identity under its lease. Import creates or decides no approval.
   A missing runtime gives exit 3. Re-import edited content before requesting/deciding approval.

   `<cli> plan --issue <number> [--workflow <id>]` starts a run for an **imported** Issue.

   **Shortcut:** `<cli> run --issue <number> [--workflow <id>] [--step <id>] [--json]` sends `plan`,
   then `dispatch` for the first ready step (or `--step`), and prints
   `runId=… stepId=… attemptId=…` (`--json`: `result.runId/stepId/attemptId`). It stops after that
   one dispatch: it does not wait and does not run the rest of the workflow; continue with `wait`.
   It goes through the same gates as `dispatch` (execution approvals, profile/quota, writer lease,
   `RUN_NOT_RUNNING`, `STEP_NOT_READY`). Any refusal is printed unchanged as `COMMAND_REFUSED`
   (exit 4). If `plan` succeeded but `dispatch` was refused, the run exists; fix the cause and use
   `dispatch --run <id> --step <id>`, since `run` again is refused with `ACTIVE_RUN_EXISTS`.
3. `<cli> dispatch --run <id> --step <id>` sends one **ready** step to a worker.
4. `<cli> wait --run <id> [--timeout <1-3600>]` blocks until no worker of the run is running
   (default 300 s). Use it instead of polling.
5. `<cli> status --run <id>` shows the run and its steps; `status --runtime` shows the runtime.
6. `<cli> deliver --run <id> --pr <n> --head-sha <sha> --check <name> [--check …] [--min-approvals <n>]`
   merges the reviewed head into `develop` and closes the task. `--head-sha` must be the head the
   independent review examined; at least one `--check` is required.

7. `<cli> merge-release --release <label> --pr <n> --head-sha <sha> [--check <name> …]`
   merges the release PR `develop` → `main` on the head the PO approved natively
   ([ADR-0039](../architecture/adr/0039-release-merge-and-two-layer-deploy-approval.md)). It runs
   `checkReleaseMerge` first, pins the native merge to `--head-sha`, and confirms the merge commit on
   `main`. PO logins come from `policies.github_approval_actors` in `project.yaml` (none configured:
   `PO_ACTORS_NOT_CONFIGURED`); the command cannot name them. A refusal prints `RELEASE_MERGE_REFUSED: <gate|merge|confirm>: <REASONS>` (exit 4) and
   merges nothing; the same command is safe to repeat (`pending`, or already merged, sends no second
   merge). **Two deploy approval layers stay (PO, 2026-11-13):** the durable approval by artifact
   digest and the native GitHub environment approval; the release merge approval replaces neither.

Refusals print `error[COMMAND_REFUSED]: <REASON>[: detail]` (exit 4). Reasons seen in the code
(not all reproduced live, see the record): `PROJECT_NOT_CONFIGURED`, `INVALID_INPUT`, `WORKFLOW_REQUIRED`,
`WORKFLOW_UNKNOWN`, `TASK_NOT_FOUND`, `WORKFLOW_CYCLIC`, `RUN_NOT_FOUND`, `RUN_NOT_RUNNING`,
`IMPLEMENTATION_MAP_EMPTY` (no valid path under `## Implementation map`; the intake gate refuses this
earlier, §9), `PLAN_KEY_REQUIRED` (not exactly one `PREFIX-NNN` marker), `STEP_NOT_READY`, `NOT_PLANNABLE`, `STATE_REJECTED`, `TASK_NOT_READY` (the Issue fails the readiness
gate, §9: `dispatch` creates no branch, attempt or worker). A usage error (exit 2) means a missing/invalid
flag; numbers must be whole (`--issue 1`, not `1e3`). Exit 3: no runtime, start the session.
Merge and PO-approval gates are in [ADR-0034](../architecture/adr/0034-task-pr-merge-gates.md).

`<cli> approvals list [--status pending|approved|rejected|expired|invalidated] [--json]`
reads the running runtime over IPC. JSON uses the standard CLI envelope with
`result.approvals`: each row has `id`, `kind`, `subjectId`, persisted `status`, `version`,
`requestedAt` (epoch milliseconds), and `decidedAt` (epoch milliseconds or null).
No subject hashes, actor identities or decision evidence are printed. An empty selection
returns an empty array. Legacy decisions without versioned request snapshots are excluded.
Unknown statuses return usage exit 2 without contacting the runtime.

Run `<cli> workflows validate [--json]` from the installed project's root before starting a
session or after editing workflows, roles, rules or skills. It reads `.omi-squad/workflows/*.yaml`
and the installed resolution catalog, including skill provenance, with the runtime's loaders;
it needs neither a running runtime nor `project.yaml`/`models.yaml`. It checks workflow schemas
and role/rule/skill references, not model capabilities or project check commands. Exit 0 means
valid; exit 1 means validation failed. Text errors include the file and failing field/path
(YAML syntax errors include line/column). JSON is exactly
`{ "ok": false, "errors": [{ "file": "...", "path": "steps.1.role", "message": "..." }] }`
on failure, or `{ "ok": true, "errors": [] }` on success. All loadable files are checked in
one invocation, so independent errors can be repaired together.

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

Create the pending request first, through the running runtime:

```sh
<cli> approvals request <subject-id> --kind business|deploy
```

It prints the request id and version (`--json`: the whole pending request). It has no decision
flag and never writes `approved`; a refused subject answers `APPROVAL_REFUSED: SUBJECT_NOT_FOUND`.

The shipped subject readers (ADR-0037) are:

- **business**: the current imported task snapshot (`subjectId` = local task id
  `task-<Issue number>`, baseline = `content_hash`, scope = that task). Use `import-task` through
  the running runtime before requesting approval. Re-import a changed revision before approval;
  requests pin that revision.
- **deploy**: an entry of `deploy_targets` in `project.yaml`
  (`[{ "id": "sandbox-r1", "target_environment": "sandbox", "artifact_digest": "sha256:<64 hex>" }]`,
  unique ids). Edit the entry for each release and restart the session; changing the digest or
  environment makes older approvals stale.

Cost and release have no subject reader yet and fail closed. No subject is inferred from agent
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

**Issue changed while the run was paused.** After the re-import, request and decide a business
approval for the new revision (`approvals request` / `approvals decide`), then run `resume` again.
With a current approval for the new hash, `resume` rebaselines: it records a `run.rebaselined`
event (old hash → new hash, approval ids) and the fresh attempt starts from the beginning of the
step on the new baseline; output of the old attempt is not reused. Without a current approval
(pending, stale, missing) it is refused as `GATE_INVALID` with detail `BUSINESS_APPROVAL_STALE` or
`BUSINESS_APPROVAL_REQUIRED`, and nothing changes. A changed config or template stays refused
(`CONFIG_OR_TEMPLATE_CHANGED`).

When it is refused (`error[COMMAND_REFUSED]: <REASON>`), the workspace is left as it is:

| Reason                                                                | What to do                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `RUN_NOT_FOUND`, `RUN_NOT_RESUMABLE`                                  | Check the id and state with `status --run <id>`; only paused/interrupted runs resume.            |
| `CHECKPOINT_MISSING`, `CHECKPOINT_INVALID`                            | The checkpoint files are missing, altered or inconsistent. Keep them for diagnosis; ask the PO. |
| `WORKSPACE_UNAVAILABLE`, `GIT_MISMATCH`                               | The worktree is gone or its head/branch changed since the checkpoint. Do not force it; ask the PO. |
| `UNCOMMITTED_MISMATCH`, `UNCOMMITTED_UNVERIFIABLE`, `ARTIFACT_HASH_MISMATCH` | Local files differ from, or cannot be matched to, the checkpoint. Resolve explicitly (commit, keep or discard by hand), then retry. |
| `GITHUB_UNRESOLVED`, `GATE_INVALID`                                   | The remote outcome is unknown, or an approval/check gate no longer holds. For `BUSINESS_APPROVAL_STALE`/`_REQUIRED`, decide a business approval for the current Issue revision, retry. |
| `NO_READY_STEP`, `DISPATCH_FAILED`, `STATE_REJECTED`                  | Inspect `status --run <id>`; a partial recovery can be retried with the same command.            |
| `PROJECT_LOCK_LOST`                                                   | Start a new session (§8).                                                                       |

A run is not Done after resume; the normal review/delivery gates still apply.

## 6. Retry

`omi retry --run <id> --step <id> [--po-decision <approval-id>] [--json]` starts a new
attempt through the existing dispatcher. It never restarts a terminal attempt (ADR-0030).
An automatically readied failed step is redispatched; an authorized failed step becomes ready;
`waiting_resource` re-enters checkpoint failover with current capability and approval gates.

| Refusal | Action |
| --- | --- |
| `PO_DECISION_REQUIRED` | The run is blocked. Obtain a run-bound approved request as below. |
| `ARCHITECT_REQUIRED` | Dispatch an Architect and record its accepted solution or no-solution event. |
| `STEP_NOT_FAILED`, `STEP_NOT_FOUND` | Inspect the run; retry requires a failed/ready/resource-waiting step with a terminal failed/interrupted attempt. |
| `RUN_NOT_RUNNING` | Use recovery for paused/interrupted runs; retry cannot restart completed/cancelled runs. |
| `NO_APPROVAL`, `APPROVAL_NOT_ACTIVE`, `STALE_REVISION`, `EXPIRED` | Obtain a current approved request; pending/rejected/invalidated decisions do not authorize reopening. |
| `SUBJECT_MISMATCH`, `WRONG_KIND`, `SCOPE_NOT_COVERED` | Request a business approval bound to this run and its imported task baseline. |
| `SELF_APPROVAL`, `ACTOR_NOT_ALLOWED`, `AUTHOR_UNKNOWN`, `SOURCE_NOT_AUTHENTICATED` | Use independent authenticated PO evidence; restore the trusted author reader if unavailable. |
| `APPROVAL_ALREADY_USED` | A previously consumed reopen ID cannot authorize another reopen; obtain a fresh decision. |
| `RETRY_BUDGET_EXHAUSTED` | Stop and resolve the operational failure. PO reopen does not replenish this budget. |

For a blocked run, create `omi approvals request <task-id> --kind business --run <run-id>`.
The request pins the current imported task baseline. Have the independent PO decide it with
`omi approvals decide <approval-id> --expected-version 0 --decision approved`; confirmation is
on the runtime-owned TTY. A headless runtime instead requires `--github-comment <numeric-id>`
with the strict, unedited decision JSON from an allowlisted human actor (ADR-0026/0037).
Then use `omi retry --run <run-id> --step <step-id> --po-decision <approval-id>`.
The application reads the mapped PR author, or the runtime GitHub identity before a PR exists,
and refuses self-approval. Shared-account/TTY identity limitations remain those of ADR-0026.

`omi rework record --run <id> --event architect_solution_accepted --intervention <id>` records
an accepted intervention. If it changes business or cost, add `--changes-business-or-cost
--po-decision <approval-id>`; the runtime verifies the approval rather than trusting a boolean.
`--event architect_no_solution` records that the Architect cannot resolve the failure.
`--event po_reopened --po-decision <approval-id>` records reopening separately from dispatch.
These use IPC `rework.record`; internal cycle/gate reports and `approvalValid` are not public inputs.

Ordinary retry preserves the quality phase, failed-cycle count and history: two failed quality
cycles → Architect → two further failures → blocked. Only an explicit approved PO reopen begins
a fresh quality segment and retains the earlier cycle/decision history. Infrastructure failures
have their own durable budget; profile/model switches and reopens do not reset it. Fix login or
invalid configuration before retrying. See [ADR-0040](../architecture/adr/0040-retry-authorization-record.md).

## 7. Update

```sh
node <new-package>/dist/bootstrap/cli.js update --project /home/user/project --package <new-package> --distribution Ubuntu-24.04
node <new-package>/dist/bootstrap/cli.js update … --apply
```

For a pinned GitHub Release, use the installed WSL2 shim:

```sh
.omi-squad/bin/omi update --project /home/user/project --distribution Ubuntu-24.04 --version 0.2.0
.omi-squad/bin/omi update --project /home/user/project --distribution Ubuntu-24.04 --version 0.2.0 --apply
```

Choose an actually published `x.y.z` version. `gh release download` uses your existing gh login
for `omi-hub-services/omi`; the updater verifies the exact release tarball against its `.sha256`,
extracts it privately and removes temporary files after the operation. Missing tags/assets,
checksum errors and unsafe archives refuse the update. No token is stored.

Release previews print changelog entries after the installed lock version through the target,
including intermediate `### Breaking` sections. Same-version updates and downgrades are refused.
A breaking apply requires adding `--accept-breaking` after reviewing those entries. JSON output
includes `changelog` and `breaking`. Use exactly one of `--version` or offline `--package`;
`--accept-breaking` applies only to `--version`. Offline `--package` keeps its existing behavior.
See [packaging.md](packaging.md#updates-and-conflicts) for error and recovery details.

Both update sources share the existing package installation implementation. Stop the managed session
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
is the same parser that ticks the criteria at delivery); and, except for an Epic, `## Implementation
map` lists at least one valid relative path (`src/domain/x.ts`, `tests/unit/`; no absolute path, `..`,
URL or glob), read by the same `implementationPaths` parser that `run`/`dispatch` use for the allowed
scope. A task without a map is refused at intake, not at `run`. Dispatch accepts the Plan Key by the
same rule (`PREFIX-NNN`, exactly one marker), so `BN-001` works like `OMI-001`. A refusal lists every
failed condition at once.
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
  checkbox at least), `## Implementation map` (one valid relative path at least) and `## Dependencies`. Without `--apply` it prints the allocated key
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

## 10. Coordinator commands and skills

`install --apply` (§1) installs `omi-status`, `omi-next` and `omi-watch` beside the existing
`omi-squad` bridge under `.claude/skills/`. Reapply is idempotent. User edits remain local; an
update that also changes the same file reports a three-way conflict instead of overwriting it.
These are Coordinator-only bridge assets, outside the curated worker catalog/provenance lock.
Workers continue receiving only assigned, hash-checked skills/rules inline: Claude disables native
slash commands and profile user settings, and Codex refuses a profile with installed skills
(ADR-0019). This is discovery/context isolation, not an OS restriction on a worker with shell access.

Use `.omi-squad/bin/omi` in WSL2, or `node .omi-squad/bin/omi.cjs` from the Windows project root.
The latter is the existing bound skill bridge launcher. File flags refer to paths **inside WSL2**;
store notes, messages and review bodies in the project's `.tmp/` directory. No prompt or free text
is assembled into a shell string. Every new command supports the normal `--json` envelope.

For an initialized project with its Issue imported, approvals recorded and a session running (§3):

1. `status --project . --json`: inspect current work first and judge the next task within PO scope.
   Use `promote --project . --issue N` if a Backlog task is ready (§9).
2. `plan --issue N --workflow feature`, then `status --run RUN` to find a ready step.
3. `dispatch --run RUN --step STEP [--notes .tmp/notes.md]`: this **existing runtime dispatch** is
   the equivalent of the dev-tool dispatch. The script reads the Issue snapshot, counts only
   top-level acceptance criteria directly under `## Acceptance criteria` (excluding nested/fenced
   boxes and subsections), generates numbered AC, worker rules and the JSON report format, then
   uses the existing `buildPrompt` for verified skills/rules. The Coordinator supplies only optional
   notes/findings, at most 2000 characters, stored as a context finding. Profile/model/effort still
   come from the existing selector and project policy; notes cannot override those settings.
4. Keep the returned attempt id. `wait --run RUN --timeout 300`, then
   `worker-report --attempt ATTEMPT`. It reads the recorded completion event rather than scanning
   native logs. `status` is the runtime verdict, `report.result` is the worker's structured claim,
   and `report.failure` explains verification failure. A running or interrupted attempt may have
   `report: null`; this is not success. Malformed output has no accepted structured report.
5. If a stopped worker could not commit, `commit-worker --attempt ATTEMPT --message-file .tmp/message.md`.
   It takes the task's writer lease, checks the branch, stages only the pinned context scope and
   rejects an empty/unsafe index, credentials, temporary state and native agent configuration.
   Repository hooks never execute: all Git commands use command-local `core.hooksPath=/dev/null`,
   without changing repository configuration or offering a hook-enabling option. Mandatory validation
   available only through hooks must be configured as required checks. Fresh required checks and
   independent review must pass on the resulting revision; a commit supplies no passing evidence.
   The resulting commit is checked against the pinned scope. An out-of-scope commit is undone locally
   with a soft reset to the pre-commit head and the index cleared; worktree files are preserved and
   the command refuses `UNSAFE_COMMIT`. It never pushes.
   Commit or post-commit validation errors trigger HEAD inspection under the writer lease. If HEAD
   did not move, the index and files remain intact and the original error is reported. If the expected
   branch's HEAD moved, the local commit is undone to the captured pre-commit SHA and the index is
   cleared while preserving files. Failed inspection, an unexpected branch or failed undo reports
   `COMMIT_RECOVERY_FAILED`; the original and recovery errors are retained together. Do not assume a
   failed command left HEAD unchanged, or retry an uncertain recovery without inspecting its state.
   Writer release failures are reported as `WRITER_RELEASE_FAILED`, even after a commit succeeds.
   Successful completion returns the new full head SHA.
   A second unchanged request refuses `NOTHING_TO_COMMIT`. An active/interrupted writer or held
   lease is a gate. Committing does not change the old report's revision or mark the step passed:
   use the workflow's recovery/rework path and obtain fresh verification at the new head.
6. Follow `status --run RUN` and dispatch the independent reviewer step on a fixed revision.
   Prepare/publish the task PR through the project's configured delivery workflow before posting
   its review. These commands do not introduce a new PR-opening interface; Issue import uses
   `import-task` (§3).
   `review-comment --pr N --file .tmp/review.md` requires this exact header with the full PR head:

   ```text
   **VERDICT:** PASS · **REVIEWED_HEAD:** `<40 lowercase hex characters>`
   AC-1: met — <evidence>
   AC-2: met — <evidence>
   ```

   Use `FAIL` with `not met` where appropriate. There must be exactly one well-formed AC line per
   top-level criterion, no duplicates or unknown numbers, and evidence on each line. PASS requires
   all met. The command reads the live PR and linked Issue before queuing a comment through the
   existing outbox. Identical retries use one operation key; a pending outcome is reconciled before
   sending again. A head can move after the read, so delivery independently rechecks its exact head.
   A comment is presentation only: it grants no approval and does not replace the runtime's
   recorded independent review. The authenticated project credential is the posting actor; no
   repository-specific Coordinator login is hard-coded.
7. Once the workflow and recorded independent review pass, use
   `deliver --run RUN --pr N --head-sha HEAD --check REQUIRED` (§3). Retry pending delivery, resolve
   refusals, and only report Done after delivery confirms it. Observe bounded rework (§6).
8. `watch --project .` serves the existing loopback monitor; open the printed URL and stop its
   terminal process when finished. Use `pause`/`resume` (§4–5) for checkpoint handoffs, or
   `session new` / `coordinator switch --to PROFILE` to end the Coordinator session cleanly.

No step falls back to raw Git/GitHub operations when a command refuses. Scope, uncovered
architecture and cost decisions go to the PO. Live Windows/WSL2, subscription and remote posting
remain opt-in verification; local fake-port tests do not establish those platform results.

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

- Init uses local onboarding; GitHub Project mapping/template copy still has no CLI.
- Init needs an explicit baseline; models remain project/workflow configuration. Import tasks
  explicitly with `import-task` after starting the session.
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
dependencies. This does not prove a clean installation of the full dependency tree. The table records that historical revision; `run` and `retry` are now available as described in §3 and §6. Native probes
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

## Workflow cost policy

All nine shipped workflows declare a cost policy: feature/bugfix/refactor use `task-default`,
docs/idea-to-issues use `lean`, and onboarding/UI-UX/CI-CD use `strict`. Strict and unknown policies
keep QA and review separate. Ordinary low/medium work can share one **fresh independent** quality
worker; high complexity, security/gate/data changes, or a gate between verify and review require
separate workers. UI-UX now runs design → implement → verify → review, retaining its original
step ids, visual evidence and per-step cost approval requirements.

Runtime plans pin the selected graph to their original template hash and record the Issue as scope
evidence when an approved Issue already has AC and an implementation map. Issue/comment prose
never approves anything. Old runs keep their original graph. The developer still uses the configured
complexity effort; analyst/first review use medium, QA/delta review low, bounded below by every
constituent capability requirement. Quality attempts use fresh sessions; author fixes may resume.

For repository development, the Coordinator can render and dispatch a combined packet:

```
node tools/coordinator/flow.ts prompt N --step verify,review --head <sha> --check-log <check-log.md> --notes <notes.md> --out <prompt.md>
node tools/coordinator/flow.ts pick-profile N --step verify,review --round 1 --probe
node tools/coordinator/flow.ts dispatch N --kind <chosen-tool> --profile <chosen-profile> --prompt <prompt.md>
```

Each dispatch writes its own packet, `~/omi-runs/omi-NNN-prompt-<step>-<attempt>-<stamp>.md` (a
native resume: `omi-NNN-resume-…`), so QA and review of one task can run in parallel without
overwriting each other. The watch shows one card per running worker, with its own skills and rules, and
`cleanup`/`prune-runs` archive these files like logs.

Use `verify,accept` for docs. A policy refusal means render the actual verify and reviewer steps
separately. Supply `--risk security,gates,data` (only applicable risks) when the PR touches sensitive
behaviour even if the declared implementation paths missed it. Review never uses the author's
resumed session. An explicit `--scope-approved <recorded-decision-ref>` records the Issue as the
scope source and omits analyze only when AC and an implementation map exist. Without that decision,
analysis remains applicable. Do not infer it from a `SCOPE-APPROVED` comment.

For a fix round, add `--round 2 --previous-verdict <verdict.md> --delta <diff.md>` and a fresh
`--head --check-log`. The worker judges only that delta plus the previous verdict and current
script evidence. QA does not rerun tests. Missing or stale evidence blocks its verdict; sandbox
EPERM is not a passing check. The runtime supplies its own recorded verdict, bounded Git diff and
check artifacts automatically, and rejects unavailable evidence or newly discovered risky paths.
Keep the existing 2 + Architect + 2, fixed-SHA, approval and merge gates.

Run `node tools/coordinator/flow.ts workflow-options` to check live Project Workflow options without
changing GitHub. Canonical template ids resolve directly; legacy `init` means onboarding-takeover,
`research` means idea-to-issues. Release/deploy values route to `prepare-release` / `deploy-release`
with their existing independent PO approval gates; `prompt` refuses to launch them as generic
workers. For a new empty project, select onboarding-empty-repo explicitly. The documented Project
option routing is checked in the default unit suite; the frozen bootstrap seed is not task state.

## Framework source repository Coordinator

[ADR-0036](../architecture/adr/0036-coordinator-single-source.md) records shared ownership and
why repository Project/comment/WSL adapters remain until runtime run/attempt state can migrate.
The future production CLI is an immutable release or explicit main-SHA build installed in an
external project, with the archive digest and framework lock retained. Never point it at a
moving develop build or install its state into this source repository.

The documented commands remain `node tools/coordinator/flow.ts <command>` and
`node tools/coordinator/status.ts`; no --import flag is needed. Workers edit the templates,
never native skills. The Coordinator previews and applies protected skill installation:

```text
node tools/coordinator/skill-installation.ts install
node tools/coordinator/skill-installation.ts install --apply
node tools/coordinator/skill-installation.ts install --check
```

`npm run check` checks template drift, registered copied-policy parity coverage and generated
prompt assets. Edit templates/prompts/, then run `npm run prompts:generate`; never edit the
generated application embedding. Source-maintenance and installed-project skill variants both
live under templates/bridges/. The installer above installs only skills, no runtime or settings.

Tooling Issue intake/readiness requires `## Framework counterpart` with a module/template or a
reason none applies. New worker packets require the shared v1 JSON result document; worker-report
prints but refuses an old free-text report. Its script-only ids do not create runtime records.
Commit-worker includes tools and the named managed root files and refuses unstaged in-scope
leftovers rather than silently omitting them. The existing branch/index gates still apply.

### Pinning repository Coordinator tooling (OMI-091 review correction)

The repository tools now run from a separate immutable clone, even while the product runtime
state migration remains deferred. See ADR-0036, "Implemented tooling pin", for the full gates
and first-install sequence. `node tools/coordinator/pin.ts status` is read-only;
`refresh --to <full-green-merge-sha> --source develop [--dry-run]` checks GitHub-owned CI before
preparing a standalone sibling checkout, installing with `npm ci --ignore-scripts` and smoking
the literal plain-Node flow command. `rollback [--dry-run]` uses the previous SHA/source with
the same gates. No commit or GitHub mutation is performed.

Set `OMI_COORDINATOR_PIN_DIR` to an absolute external path to override sibling
`omi-coordinator-pin`; its parent directory must already exist. On Windows the bundled npm CLI
is launched through Node, without a cmd shell. Run pin mutations only between Coordinator
commands. Failed preparation leaves the old pin untouched; dirty or mismatched pins refuse.
The historical seed predates this bootstrap, so first install requires a green merge containing
it rather than activating that older seed.

The skill installer expands the shared pin bootstrap deterministically. Installed skills find
the external directory without executing source from develop, then call the external pin's
own status/flow/watch scripts. Keep the host work checkout as cwd and configure
`OMI_WSL_REPO_DIR` for the task; prompts/workflows/skills/rules come from the pin, while Git,
checks and workers operate on the WSL target. Reinstall skills from templates after merging
changes; workers do not edit native skills.


The installed pin bootstrap now validates physical checkout/entry-point isolation using an
embedded Node-built-in guard before executing the configured pin. Host/WSL worktrees and their
aliases are rejected without invoking the candidate status script. Its status response must
match the guard's canonical path and cannot redirect later commands.

Repository `worker-report` prints the complete validated JSON result plus log metadata, preserving
revision SHA, status, findings, checks and artifacts. Valid blocked/failed results return exit 1;
a valid succeeded result returns 0. Inspect the document even on nonzero exit, and use its
`revision.headSha` for the fixed-head check. Never treat a summary or schema validity as approval.

A worker without a shell (for example a read-only analyze step with only `Read,Edit,Write,Glob,Grep`)
reports each artifact by `path` only: the runtime registers the file, computes its sha-256 and
records that hash. A `sha256` the worker does add must match, and a missing file, a symlink or a
path outside the attempt's artifact root still fails the step (`ARTIFACT_INVALID`,
`ARTIFACT_HASH_MISMATCH`, `PATH_OUTSIDE_ROOT`). `revision` is only a claim: the runtime records its
own head and merge-base with `develop`. A missing or malformed claim is ignored, and a worker's
`baseSha` is never used; a well-formed `headSha` that differs from the worktree head is refused as
`STALE_REVISION`. If the runtime cannot compute the merge-base, the step fails closed with
`REVISION_MISSING`. Diagnostic text keeps 40/64-character lowercase hex
(git SHAs) and still redacts secret-prefixed and other long tokens.

A worker writes its artifacts only into the attempt's absolute artifact directory
(`<store>/attempts/<attemptId>`, under `.omi-squad/local/runs`), never into the task worktree or
branch. The runtime creates it before the start and grants exactly that one directory (Claude Code
`--add-dir`, Codex `--add-dir`) to `workspace-write` workers; read-only workers get none. The prompt
names the absolute directory, while the `path` in the result stays store-relative
(`attempts/<attemptId>/<file>`). A dispatch whose artifact directory would sit inside the worktree
is refused (`CONTEXT_REJECTED`, `ARTIFACT_DIR_IN_WORKSPACE`) before any attempt exists, and an
artifact directory that is missing at start fails the start as `INVALID_REQUEST`, not as a worker
failure.

Recovery when a step still fails with `ARTIFACT_INVALID` and the file is not in the store: the
failure cannot be told apart from a worker that never wrote the file, so it is counted like any
other failed attempt against the quality budget (`ARTIFACT_INVALID` is not reclassified as an
infrastructure failure). If the cause is a framework defect (the file sits under the worktree, as
in beta #55 before OMI-131), do not retry blindly: fix the framework, remove the stray
`attempts/` directory from the worktree (it is untracked; never commit it), and have the
Architect/PO reopen the step so the failed attempt does not consume the remaining cycle.

Each dispatch has its own log `omi-NNN-<profile>-<ts>-<step>-<attempt>-<stamp>.jsonl` (and `.err`,
codex `-last.md`), so QA and review can run in parallel on one profile. When several workers of a
task run, read each with `worker-report <issue> --step verify-1` (or `review-1`); without `--step`
it returns the newest log of the task.

Product CLI commands and repo `flow.ts` commands have different argument shapes; do not
interchange them.

## Work Type / Workflow intake invariant (OMI-112)

New-Issue specs and existing-Issue readiness use `workTypeWorkflowReasons` in
`src/domain/tasks/readiness-gate.ts` through the shared spec/readiness policies.
Bug ⇔ `bugfix`, Docs ⇔ `docs`, Release ⇔ `release` or `deploy`; Task/Spike use other
workflows. Epic containers are exempt from this invariant (new-issue still refuses Epics).
A Bug needs a non-empty `## Tái hiện` section containing steps, logs or evidence;
comments and headings inside fenced examples do not satisfy it. A Task with that section
is refused with a hint to use Bug/bugfix. These reasons also block promote, set-status
to Ready/In Progress and start-branch/dispatch, and appear in status Attention for
existing open non-Epic Issues. Correct the Issue fields/body; do not bypass the gate.
