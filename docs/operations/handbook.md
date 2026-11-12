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

**What the v0.1 CLI really has.** `--help` lists exactly: `install`, `update`, `doctor`, `status`,
`session {new,start}`, `approvals decide`, `plan`, `dispatch`, `wait`, `pause`, `resume`, `deliver`,
`coordinator switch`.

| Job            | v0.1 command                                      | Notes                                                              |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| init           | `install` / `doctor` only                         | `init` **not available in v0.1** (see §1)                          |
| login/profiles | none                                              | `login`, `profiles` **not available in v0.1** (see §2)             |
| run            | `plan` → `dispatch` → `wait` → `status` → `deliver` | `run` **not available in v0.1** (see §3)                         |
| pause / resume | `pause`, `resume`                                 | §4, §5                                                             |
| retry          | none                                              | `retry` **not available in v0.1** (see §6)                         |
| update         | `update`                                          | §7                                                                 |
| recovery       | `status`, `resume`, `session new`, backups        | §8                                                                 |

Also **not available in v0.1**: `approvals list`, `workflows validate`, `sync` (architecture.md §13
is a design, not the current surface).

**Exit codes** (stable, ADR-0020): `0` ok (the command succeeded, not "the task passed"), `1` failure
inside the CLI or runtime (also `install`/`update` conflicts and a failing `doctor`), `2` usage
error (nothing sent), `3` no runtime on the socket or timeout, `4` the runtime refused the request
(`COMMAND_REFUSED`, `NOT_IMPLEMENTED`, …), `5` malformed runtime answer. Text mode prints errors on
stderr as `error[CODE]: message`.

**First thing to try when anything fails:** `<cli> status`. Exit 3 means no runtime is running
(start a session, §3). Exit 0 prints `runtime: ready`, `version: …`, `started: …`.

## 1. Init

**Install the framework into a project** (the only init step the CLI has). Preview first, then apply
the same arguments. Details, Windows invocation and the bootstrap archive are in packaging.md.

```sh
node <package>/dist/bootstrap/cli.js install --project /home/user/project --package <package> --distribution Ubuntu-24.04
node <package>/dist/bootstrap/cli.js install --project /home/user/project --package <package> --distribution Ubuntu-24.04 --apply
<cli> doctor --project /home/user/project --distribution Ubuntu-24.04
```

- `install` without `--apply` writes nothing and prints `preview: <version>; changes: <template paths>`
  (31 template files for a new project: `roles/`, `rules/`, `skills/`, `provenance/`, `workflows/`).
- `--apply` backs up, installs the package under `.omi-squad/tool/`, and writes the shims and templates.
- `doctor` prints `WSL2 installation checks passed` (exit 0) or `error[INTERNAL_ERROR]: <check>: <detail>; …`
  (exit 1) naming each failed check (`interop`, `distribution-version`, `windows-launch`, …).

When it fails:

| Symptom                                           | Meaning / action                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `INVALID_INSTALLATION_TARGET`                     | The project is the framework source repo or inside it, under `/mnt/<drive>`, a symlinked path, or inside the package dir. Use a project on the Linux filesystem outside this repository. |
| `UNMANAGED_TOOL_INSTALLATION`                     | `.omi-squad/tool`, `bin/omi` or `bin/omi.cjs` exists without a framework lock. Remove or move it yourself; the installer will not overwrite it. |
| `Template conflicts: <paths>`                     | See §7.                                                                                                   |
| `doctor` fails on `interop` / `distribution-version` | Run it from WSL2 with Windows interop enabled and the distro registered as WSL 2 (`wsl.exe --list --verbose`). |

**Gap: project configuration.** `install` does not create `.omi-squad/config/project.yaml`, and no
CLI command creates it (the `initializeProject` use case exists, ADR-0029, but has no command).
Until the file exists, the runtime starts but every run command is refused:
`error[COMMAND_REFUSED]: PROJECT_NOT_CONFIGURED` (exit 4). `status` (no `--run`) still works.
See [Open decisions](#known-limitations).

## 2. Login (profiles)

**There is no `login` or `profiles` command in v0.1.** Logins are done with the native tools, on the
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

Not verified here: the native login steps themselves (they need a real subscription and were not run).
No v0.1 command registers or probes a profile in the runtime (no caller outside tests was found):
see [Open decisions](#known-limitations).

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
5. `<cli> status --run <id>` shows the run and its steps; `status` alone shows the runtime.
6. `<cli> deliver --run <id> --pr <n> --head-sha <sha> --check <name> [--check …] [--min-approvals <n>]`
   merges the reviewed head into `develop` and closes the task. `--head-sha` must be the head the
   independent review examined; at least one `--check` is required.

Refusals print `error[COMMAND_REFUSED]: <REASON>[: detail]` (exit 4). Reasons seen in the code
(not all reproduced live, see the record): `PROJECT_NOT_CONFIGURED`, `INVALID_INPUT`, `WORKFLOW_REQUIRED`,
`WORKFLOW_UNKNOWN`, `TASK_NOT_FOUND`, `WORKFLOW_CYCLIC`, `RUN_NOT_FOUND`, `RUN_NOT_RUNNING`,
`STEP_NOT_READY`, `NOT_PLANNABLE`, `STATE_REJECTED`. A usage error (exit 2) means a missing/invalid
flag; numbers must be whole (`--issue 1`, not `1e3`). Exit 3: no runtime, start the session.
Merge and PO-approval gates are in [ADR-0034](../architecture/adr/0034-task-pr-merge-gates.md); an
`approvals decide` call currently answers `NOT_IMPLEMENTED` (known limitation).

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

**`retry` is not available in v0.1** (architecture.md §13 designs `retry --task`; it is not
implemented). What exists:

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

## Compatibility matrix

Versions, auth modes and their evidence are in [compatibility.md](compatibility.md); a version not
listed there is `untested`. This table adds only what the CLI itself depends on:

| Area                                     | Status in v0.1                  | Evidence                                                                 |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| WSL2 Ubuntu, Node 24, Linux filesystem   | supported (see compatibility.md)| `npm run check`; CLI check in the record below                           |
| `status`, usage/exit codes, runtime start/stop in WSL2 | checked 2026-11-12 | record below (throwaway project, no GitHub/profile/worker touched)   |
| `install`/`update` preview                | checked 2026-11-12             | record below                                                              |
| `install --apply` with real npm provisioning, clean WSL2 | untested        | packaging.md (offline tests only)                                         |
| Windows launcher, UNC shim, `session start`, `doctor` interop | untested   | ADR-0030 limits; `doctor` fails without WSL interop (checked)             |
| Run commands against a configured project, real GitHub | untested here       | refusals before project config only; see ADRs for offline tests           |
| Windows 11 Coordinator                   | untested                        | compatibility.md                                                          |

## Known limitations

- No `init`, `login`, `profiles`, `run`, `retry`, `approvals list`, `workflows validate`, `sync`.
- `project.yaml` has no creating command; `install` does not write it (ADR-0029 wiring deferred).
- `approvals decide` answers `error[NOT_IMPLEMENTED]: approval decisions is not implemented yet` from the
  shipped runtime (the approval use cases are not wired into its composition).
- `install` preview lists only `.omi-squad/` template files; no `.claude/skills/omi-squad/SKILL.md`
  bridge and no `CLAUDE.md`/`AGENTS.md` merge are installed, although architecture.md §4 designs them.
- `session` has no `stop`: Ctrl-C on the foreground launcher (or closing the Coordinator) is the stop.
  `session stop --help` prints the `session` help.
- `doctor` failure uses the generic exit 1 / `INTERNAL_ERROR`, not a dedicated code.
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

Checked on 2026-11-12 in WSL2 with `npm run build` then `node dist/bootstrap/cli.js …`, in a
throwaway project under `.tmp/handbook-project/` (runtime started with `dist/bootstrap/runtime.js`,
no `project.yaml`, so no GitHub, profile or worker was reachable) and, for `install`/`update`
previews, in a temporary directory under the OS temp dir (the source repo is refused as a target).

| Command                                                                 | Observed                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `--help` and `<command> --help` for every command above                 | Flags and descriptions as documented; `session stop --help` shows `session` help |
| `init`, `login`, `run --issue 1`, `retry --task t`, `profiles list`     | exit 2 `error[USAGE]: unknown command '…'`                                   |
| `status` (no runtime)                                                   | exit 3 `error[RUNTIME_UNAVAILABLE]: no runtime is listening on <socket> (ENOENT)`; `--json` same code |
| `pause --run r1` (no reason)                                            | exit 2 `give exactly one of --reason and --reason-stdin`                     |
| `status` (runtime up)                                                   | exit 0 `runtime: ready` / `version: 0.0.0` / `started: <ISO time>`; `--json` has `state`, `runtimeVersion`, `startedAt`, `attempts`, `runs` |
| `status --run`, `plan`, `dispatch`, `wait`, `pause`, `resume`, `session new`, `coordinator switch` (runtime up, no `project.yaml`) | exit 4 `error[COMMAND_REFUSED]: PROJECT_NOT_CONFIGURED` |
| `approvals decide a1 --expected-version 1 --decision approved`          | exit 4 `error[NOT_IMPLEMENTED]: approval decisions is not implemented yet`   |
| `install` / `update` preview, on a temp project                          | exit 0 `preview: 0.0.0; changes: …` (31 template paths), nothing written     |
| `install` with the project inside this repo                             | exit 1 `INVALID_INSTALLATION_TARGET`                                         |
| `doctor` in this sandbox                                                | exit 1 failing `interop`, `distribution-version`, `windows-launch`           |
| runtime stop (`stop` on stdin)                                          | runtime process exit 0                                                       |

Not run: `install/update --apply`, `session start` (needs `wsl.exe`), `deliver`, and the
success paths of `plan`/`dispatch`/`pause`/`resume` (need a configured project, GitHub and a worker).
Their refusal reasons above come from the source and are marked as such. Exit code 5 was not observed.
