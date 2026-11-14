# CLI reconciliation evidence — 2026-11-13

Documentation evidence for source revision `24e475f4789415d8b15eb99a68f6d4c955e4ca22`,
Node-built package `omi-squad` 0.0.0. `npm run build` exited 0 (`tsc -p tsconfig.build.json`).
Help/local captures below used `node <root>/.tmp/omi-083/package/dist/bootstrap/cli.js` with cwd
`<root>/.tmp/omi-083/project`. `<root>` denotes this worktree, not a global install.
No native login, model calls, GitHub mutation, deployment or pin refresh was performed.
Raw local captures and the smoke driver are gitignored under `.tmp/omi-083/`; this appendix
preserves help and relevant output so review does not depend on those temporary files.

## Reproduction and interpretation

Build first. Create an empty project under `.tmp/` and a JSON baseline with:

```json
{"schema_version":1,"repository":{"owner":"example","name":"project"},"project":{"owner":"example","number":1},"branches":{"integration":"develop","release":"main"},"limits":{"max_parallel_workers":2,"step_timeout_seconds":120,"max_rework_cycles":4},"policies":{"mandatory_approvals":["release","deploy"]}}
```

Set `<project>` to its absolute path, `<baseline>` to this JSON file, and run the exact
arguments in the captures below. Help is syntax evidence, not proof of successful runtime or
remote operation. The init preview/apply/repeated apply succeeded; repeated apply kept files.
An initial run directly from the source dist refused install/update for a project nested in
the framework source (`INVALID_INSTALLATION_TARGET`), even with a copied package argument. This is negative
path evidence, not a successful full installation. No install `--apply` was attempted. A second run copied the built dist/templates/schemas/migrations
and package metadata into sibling `.tmp/omi-083/package/`, reusing existing node_modules via
a symlink for offline imports. Install/update previews then succeeded (exit 0, status preview),
including all three Coordinator skills. This is not full dependency installation evidence.
Doctor failed its Windows/WSL interop checks in this sandbox. Runtime status returned EPERM;
this is not a successful IPC check. Approval/worker/delivery/session/watch/intake success paths
were not exercised live. Historical smoke evidence in handbook remains dated separately.
No deploy/release/rollback/import CLI exists in this revision; application/live-test integrations
are described as such. `approvals list` and `workflows validate` are also absent from help.

## Source reconciliation map

| Document | Sources checked / corrections |
| --- | --- |
| architecture §3, §4, §13 | `src/application/use-cases/` (plan-run, task snapshot storage); `src/infrastructure/observability/` (watch, no Pino); migration 0006 and profile registry; `src/interfaces/cli/commands/` and all help captures below; `templates/bridges/repository/`, ADR-0036/0037 |
| product-overview | Command inventory below; `store-task-snapshots.ts`, approval subject composition in `src/bootstrap/container.ts`; ADR-0036 repo procedure versus runtime boundary |
| tech-stack | `package.json`, `.nvmrc`, `tsconfig.build.json`, installation command handler; dependency pins, build scope, init flags and check inventory |
| design-patterns | `templates/project/.omi-squad/rules/script-first.md`, `src/domain/runs/rework-policy.ts`, ADR-0036; full 2 + Architect + 2 with separate operational retry |
| compatibility | ADR-0031 live evidence and PO resolutions; current CLI smoke does not extend live version support |
| handbook | Complete help inventory including worker-report/commit-worker/review-comment/prune-logs; ADR-0036 pin implementation versus deferred state migration |
| packaging | install/update/init/doctor captures; `src/infrastructure/config/project-bridge.ts`, `templates/bridges/`; full native dependency install remains unverified |
| deploy-runbook | approvals help; `tools/sandbox-setup/main.ts` argument parser (github/local-state only); ADR-0037 in-process import and deploy config subjects |

## Stale ADR inventory and handling

Historical decisions are preserved. Status notes below distinguish original implementation
snapshots from current behavior; no decision is silently rewritten.

| ADR | Stale content / handling |
| --- | --- |
| 0014 | “switch when status/run exist”, old tooling boundaries and command snapshots predate shared source and pin. Status note added pointing to ADR-0036; runtime-state migration remains deferred. |
| 0020 | “only status wired”, five command stubs and exit table predate current CLI. Status note added referencing current help and exit 6; protocol decision unchanged. |
| 0031 | Product blocker/future failover wording predates implemented failover and PO close resolutions. Status note added; real-limit/concurrent-refresh evidence limits retained. |
| 0037 | Setup example names sandbox live-prep, but current parser has no such command. Status note added: use cases exist; operator import integration is missing. No new approval pathway is implied. |
| 0013, 0021, 0023 | Single-profile/adapter evidence is historical, supplemented by ADR-0031; keep original version-specific evidence and its explicit limits. No decision change needed. |
| 0033 | Repository quota endpoint evidence is not general live support for every runtime/profile. Retain evidence scope; no decision change needed. |
| 0036 | Current pin and transitional parity source of truth; no stale decision identified. Automatic repo rework/state migration remains explicitly deferred. |

No new PO decision is required for these documentation status notes. Implementing snapshot import
setup or migrating repo runtime state needs its own scoped task; this audit does not implement
it. Existing PO decisions in ADR-0031 are retained, not reopened.

## Captured CLI help and local executions

### `--help` — exit 0

```text
Usage: omi-squad [options] [command]

omi-squad command line (IPC skeleton)

Options:
  -V, --version                          output the version number
  --json                                 print one machine-readable JSON document
  --socket <path>                        runtime socket path
  -h, --help                             display help for command

Commands:
  init [options]                         Preview local project onboarding from an explicit JSON config baseline
  install [options]                      Preview a project-local package installation; --apply writes after backup
  update [options]                       Preview a project-local package installation; --apply writes after backup
  doctor [options]
  status [options]                       Summarise tasks, PRs, workers, quota and the next task
  watch [options]                        Watch runtime workflow diagrams in a local browser
  session                                Managed foreground session (Ctrl-C to stop)
  approvals                              Versioned PO decisions
  plan [options]                         Start a run of a workflow for an imported Issue
  dispatch [options]                     Dispatch one ready step of a run to a worker
  worker-report [options]                Read the recorded worker result and its verification outcome
  commit-worker [options]                Commit a stopped worker's allowed output paths without executing hooks
  review-comment [options]               Validate a review verdict against the live PR head and Issue AC before posting
  wait [options]                         Wait until no worker of the run is running, or the timeout passes
  pause [options]                        Pause a run at a checkpoint with its workers stopped
  resume [options]                       Resume a paused or interrupted run from its checkpoint
  deliver [options]                      Merge the reviewed head of a finished run into develop and close the task
  coordinator                            Coordinator session handoff
  profiles                               Native subscription profile metadata (login with the native tool first)
  new-issue [options]                    Preview a new task Issue from a Markdown spec; --apply creates it on GitHub
  promote [options] [issue]              Move a Backlog task to Ready when its blockers are closed and the gate passes
  set-status [options] <issue> <status>  Set a task's Project Status to Ready or In Progress; the readiness gate applies
  prune-logs [options]                   Archive the worker logs of Done tasks and cap archive/ (also runs after task close)
  help [command]                         display help for command
```

### `init --help` — exit 0

```text
Usage: omi-squad init [options]

Preview local project onboarding from an explicit JSON config baseline

Options:
  --project <path>     absolute Linux project path
  --config <path>      JSON project config baseline (repository, Project,
                       branches, policies)
  --variant <variant>  new or existing codebase (default: "existing")
  --apply              create missing onboarding files; keep existing files
  -h, --help           display help for command
```

### `install --help` — exit 0

```text
Usage: omi-squad install [options]

Preview a project-local package installation; --apply writes after backup

Options:
  --project <path>       absolute Linux project path
  --package <path>       absolute path to an extracted omi-squad tarball
  --distribution <name>  bound WSL2 distro
  --apply                apply the previewed installation
  -h, --help             display help for command
```

### `update --help` — exit 0

```text
Usage: omi-squad update [options]

Preview a project-local package installation; --apply writes after backup

Options:
  --project <path>       absolute Linux project path
  --package <path>       absolute path to an extracted omi-squad tarball
  --distribution <name>  bound WSL2 distro
  --apply                apply the previewed installation
  -h, --help             display help for command
```

### `doctor --help` — exit 0

```text
Usage: omi-squad doctor [options]

Options:
  --project <path>       absolute Linux project path
  --distribution <name>  bound WSL2 distro
  -h, --help             display help for command
```

### `status --help` — exit 0

```text
Usage: omi-squad status [options]

Summarise tasks, PRs, workers, quota and the next task

Options:
  --project <path>  project directory (default: ".")
  --runtime         inspect the runtime over IPC
  --run <id>        report this run and its steps instead of the runtime
  -h, --help        display help for command
```

### `watch --help` — exit 0

```text
Usage: omi-squad watch [options]

Watch runtime workflow diagrams in a local browser

Options:
  --project <path>      project directory (default: ".")
  --port <number>       loopback port (0 chooses an available port) (default:
                        "4381")
  --interval <seconds>  snapshot refresh interval (default: "5")
  -h, --help            display help for command
```

### `plan --help` — exit 0

```text
Usage: omi-squad plan [options]

Start a run of a workflow for an imported Issue

Options:
  --issue <number>  Issue number
  --workflow <id>   workflow template id
  -h, --help        display help for command
```

### `dispatch --help` — exit 0

```text
Usage: omi-squad dispatch [options]

Dispatch one ready step of a run to a worker

Options:
  --run <id>      run id
  --step <id>     workflow step id
  --notes <file>  Coordinator notes only; the runtime builds the worker prompt
  -h, --help      display help for command
```

### `worker-report --help` — exit 0

```text
Usage: omi-squad worker-report [options]

Read the recorded worker result and its verification outcome

Options:
  --attempt <id>  attempt id returned by dispatch
  -h, --help      display help for command
```

### `commit-worker --help` — exit 0

```text
Usage: omi-squad commit-worker [options]

Commit a stopped worker's allowed output paths without executing hooks

Options:
  --attempt <id>         stopped attempt id
  --message-file <file>  commit message file
  -h, --help             display help for command
```

### `review-comment --help` — exit 0

```text
Usage: omi-squad review-comment [options]

Validate a review verdict against the live PR head and Issue AC before posting

Options:
  --pr <number>  pull request number
  --file <file>  independent review body
  -h, --help     display help for command
```

### `wait --help` — exit 0

```text
Usage: omi-squad wait [options]

Wait until no worker of the run is running, or the timeout passes

Options:
  --run <id>           run id
  --timeout <seconds>  give up after this many seconds (1-3600) (default: "300")
  -h, --help           display help for command
```

### `pause --help` — exit 0

```text
Usage: omi-squad pause [options]

Pause a run at a checkpoint with its workers stopped

Options:
  --run <id>       run id
  --reason <text>  why (audit text, 1-500 characters)
  --reason-stdin   read the reason from stdin (use this for text from a script)
  -h, --help       display help for command
```

### `resume --help` — exit 0

```text
Usage: omi-squad resume [options]

Resume a paused or interrupted run from its checkpoint

Options:
  --run <id>  run id
  -h, --help  display help for command
```

### `deliver --help` — exit 0

```text
Usage: omi-squad deliver [options]

Merge the reviewed head of a finished run into develop and close the task

Options:
  --run <id>               run id
  --pr <number>            pull request number
  --head-sha <sha>         the head the independent review examined
  --check <name>           required check name (repeatable, at least one)
                           (default: [])
  --min-approvals <count>  minimum native approvals
  -h, --help               display help for command
```

### `new-issue --help` — exit 0

```text
Usage: omi-squad new-issue [options]

Preview a new task Issue from a Markdown spec; --apply creates it on GitHub

Options:
  --project <path>   absolute Linux project path
  --file <path>      Markdown spec with YAML frontmatter
  --prefix <prefix>  Plan Key prefix of the project (default: "OMI")
  --apply            create the Issue (without it nothing is written)
  -h, --help         display help for command
```

### `promote --help` — exit 0

```text
Usage: omi-squad promote [options] [issue]

Move a Backlog task to Ready when its blockers are closed and the gate passes

Arguments:
  issue             Issue number; without it the first eligible Backlog task is
                    used

Options:
  --project <path>  absolute Linux project path
  --dry-run         show what would be promoted and write nothing
  -h, --help        display help for command
```

### `set-status --help` — exit 0

```text
Usage: omi-squad set-status [options] <issue> <status>

Set a task's Project Status to Ready or In Progress; the readiness gate applies

Arguments:
  issue             Issue number
  status            Ready | In Progress

Options:
  --project <path>  absolute Linux project path
  -h, --help        display help for command
```

### `prune-logs --help` — exit 0

```text
Usage: omi-squad prune-logs [options]

Archive the worker logs of Done tasks and cap archive/ (also runs after task
close)

Options:
  --project <path>  absolute Linux project path
  --task <id...>    Done task id whose logs may be archived (repeatable)
  --dry-run         show the plan and change nothing
  -h, --help        display help for command
```

### `session --help` — exit 0

```text
Usage: omi-squad session [options] [command]

Managed foreground session (Ctrl-C to stop)

Options:
  -h, --help       display help for command

Commands:
  new              End this Coordinator session cleanly: pause all runs so a new
                   session can resume
  start [options]
  help [command]   display help for command
```

### `session new --help` — exit 0

```text
Usage: omi-squad session new [options]

End this Coordinator session cleanly: pause all runs so a new session can resume

Options:
  -h, --help  display help for command
```

### `session start --help` — exit 0

```text
Usage: omi-squad session start [options]

Options:
  --project <wsl-path>        absolute project path in WSL
  --runtime <wsl-path>        absolute compiled runtime.js path in WSL
  --distribution <name>       WSL distribution
  --coordinator <executable>  Windows Coordinator executable (default: "claude")
  -h, --help                  display help for command
```

### `approvals --help` — exit 0

```text
Usage: omi-squad approvals [options] [command]

Versioned PO decisions

Options:
  -h, --help                      display help for command

Commands:
  request [options] <subject-id>  create a pending approval request for a
                                  trusted subject; it never records a decision
  decide [options] <approval-id>
  help [command]                  display help for command
```

### `approvals request --help` — exit 0

```text
Usage: omi-squad approvals request [options] <subject-id>

create a pending approval request for a trusted subject; it never records a
decision

Options:
  --kind <kind>  business or deploy
  -h, --help     display help for command
```

### `approvals decide --help` — exit 0

```text
Usage: omi-squad approvals decide [options] <approval-id>

Options:
  --expected-version <version>  expected request version
  --decision <decision>         approved or rejected
  --reason <reason>             reason (required for rejection)
  --github-comment <id>         verify an allowlisted GitHub actor's decision
                                instead of prompting on the runtime terminal
  -h, --help                    display help for command
```

### `coordinator --help` — exit 0

```text
Usage: omi-squad coordinator [options] [command]

Coordinator session handoff

Options:
  -h, --help        display help for command

Commands:
  switch [options]  Pause all runs so the PO can continue with another
                    Coordinator profile
  help [command]    display help for command
```

### `coordinator switch --help` — exit 0

```text
Usage: omi-squad coordinator switch [options]

Pause all runs so the PO can continue with another Coordinator profile

Options:
  --to <profile>  label of the Windows Coordinator profile to use next
  -h, --help      display help for command
```

### `profiles --help` — exit 0

```text
Usage: omi-squad profiles [options] [command]

Native subscription profile metadata (login with the native tool first)

Options:
  -h, --help               display help for command

Commands:
  register [options] <id>
  list
  probe <id>
  help [command]           display help for command
```

### `profiles register --help` — exit 0

```text
Usage: omi-squad profiles register [options] <id>

Options:
  --tool <tool>          claude-code or codex
  --profile-home <path>  native CLAUDE_CONFIG_DIR or CODEX_HOME directory
  --account-group <id>   same account uses the same quota group
  --model <name>         verified native model name (repeatable) (default: [])
  -h, --help             display help for command
```

### `profiles list --help` — exit 0

```text
Usage: omi-squad profiles list [options]

Options:
  -h, --help  display help for command
```

### `profiles probe --help` — exit 0

```text
Usage: omi-squad profiles probe [options] <id>

Options:
  -h, --help  display help for command
```

### `install --project <root>/.tmp/omi-083/project --package <root>/.tmp/omi-083/package --distribution Ubuntu-24.04 --json` — exit 0

```text
{
  "schemaVersion": 1,
  "ok": true,
  "exitCode": 0,
  "result": {
    "version": "0.0.0",
    "conflicts": [],
    "changes": [
      "bridge/AGENTS.md",
      "bridge/CLAUDE.md",
      "bridge/skill/SKILL.md",
      "bridge/skill/bridge.config.json",
      "bridge/skill/bridge.ts",
      "bridge/skills/omi-next/SKILL.md",
      "bridge/skills/omi-status/SKILL.md",
      "bridge/skills/omi-watch/SKILL.md",
      "provenance/skills.lock.json",
      "roles/analyst.yaml",
      "roles/architect.yaml",
      "roles/designer.yaml",
      "roles/developer.yaml",
      "roles/qa.yaml",
      "roles/reviewer.yaml",
      "rules/approval-gates.md",
      "rules/architecture-boundaries.md",
      "rules/evidence-and-tests.md",
      "rules/issue-decomposition.md",
      "rules/project-baseline.md",
      "rules/script-first.md",
      "skills/NOTICE.md",
      "skills/frontend-design-quality/SKILL.md",
      "skills/independent-review/SKILL.md",
      "skills/minimal-change/SKILL.md",
      "skills/receiving-code-review/SKILL.md",
      "skills/requirements-analysis/SKILL.md",
      "skills/systematic-debugging/SKILL.md",
      "skills/test-driven-development/SKILL.md",
      "skills/ui-ux-review-checklist/SKILL.md",
      "skills/verification-before-completion/SKILL.md",
      "workflows/bugfix.yaml",
      "workflows/ci-cd.yaml",
      "workflows/docs.yaml",
      "workflows/feature.yaml",
      "workflows/idea-to-issues.yaml",
      "workflows/onboarding-empty-repo.yaml",
      "workflows/onboarding-takeover.yaml",
      "workflows/refactor.yaml",
      "workflows/ui-ux.yaml"
    ],
    "status": "preview"
  }
}
```

### `update --project <root>/.tmp/omi-083/project --package <root>/.tmp/omi-083/package --distribution Ubuntu-24.04 --json` — exit 0

```text
{
  "schemaVersion": 1,
  "ok": true,
  "exitCode": 0,
  "result": {
    "version": "0.0.0",
    "conflicts": [],
    "changes": [
      "bridge/AGENTS.md",
      "bridge/CLAUDE.md",
      "bridge/skill/SKILL.md",
      "bridge/skill/bridge.config.json",
      "bridge/skill/bridge.ts",
      "bridge/skills/omi-next/SKILL.md",
      "bridge/skills/omi-status/SKILL.md",
      "bridge/skills/omi-watch/SKILL.md",
      "provenance/skills.lock.json",
      "roles/analyst.yaml",
      "roles/architect.yaml",
      "roles/designer.yaml",
      "roles/developer.yaml",
      "roles/qa.yaml",
      "roles/reviewer.yaml",
      "rules/approval-gates.md",
      "rules/architecture-boundaries.md",
      "rules/evidence-and-tests.md",
      "rules/issue-decomposition.md",
      "rules/project-baseline.md",
      "rules/script-first.md",
      "skills/NOTICE.md",
      "skills/frontend-design-quality/SKILL.md",
      "skills/independent-review/SKILL.md",
      "skills/minimal-change/SKILL.md",
      "skills/receiving-code-review/SKILL.md",
      "skills/requirements-analysis/SKILL.md",
      "skills/systematic-debugging/SKILL.md",
      "skills/test-driven-development/SKILL.md",
      "skills/ui-ux-review-checklist/SKILL.md",
      "skills/verification-before-completion/SKILL.md",
      "workflows/bugfix.yaml",
      "workflows/ci-cd.yaml",
      "workflows/docs.yaml",
      "workflows/feature.yaml",
      "workflows/idea-to-issues.yaml",
      "workflows/onboarding-empty-repo.yaml",
      "workflows/onboarding-takeover.yaml",
      "workflows/refactor.yaml",
      "workflows/ui-ux.yaml"
    ],
    "status": "preview"
  }
}
```

### `init --project <root>/.tmp/omi-083/project --config <root>/.tmp/omi-083/baseline.json --json` — exit 0

```text
{
  "schemaVersion": 1,
  "ok": true,
  "exitCode": 0,
  "result": {
    "kind": "codebase",
    "status": "preview",
    "variant": "existing",
    "detection": {
      "language": "unknown",
      "other_languages": [],
      "commands": {},
      "evidence": []
    },
    "files": [
      {
        "path": ".omi-squad/config/project.yaml",
        "action": "would-create"
      },
      {
        "path": ".omi-squad/workflows/onboarding-takeover.yaml",
        "action": "would-create"
      },
      {
        "path": ".omi-squad/config/codebase.yaml",
        "action": "would-create"
      },
      {
        "path": ".omi-squad/config/onboarding-plan.md",
        "action": "would-create"
      }
    ]
  }
}
```

### `init --project <root>/.tmp/omi-083/project --config <root>/.tmp/omi-083/baseline.json --apply --json` — exit 0

```text
{
  "schemaVersion": 1,
  "ok": true,
  "exitCode": 0,
  "result": {
    "kind": "codebase",
    "status": "applied",
    "variant": "existing",
    "detection": {
      "language": "unknown",
      "other_languages": [],
      "commands": {},
      "evidence": []
    },
    "files": [
      {
        "path": ".omi-squad/config/project.yaml",
        "action": "created"
      },
      {
        "path": ".omi-squad/workflows/onboarding-takeover.yaml",
        "action": "created"
      },
      {
        "path": ".omi-squad/config/codebase.yaml",
        "action": "created"
      },
      {
        "path": ".omi-squad/config/onboarding-plan.md",
        "action": "created"
      }
    ]
  }
}
```

### `init --project <root>/.tmp/omi-083/project --config <root>/.tmp/omi-083/baseline.json --apply --json` — exit 0

```text
{
  "schemaVersion": 1,
  "ok": true,
  "exitCode": 0,
  "result": {
    "kind": "codebase",
    "status": "applied",
    "variant": "existing",
    "detection": {
      "language": "unknown",
      "other_languages": [],
      "commands": {},
      "evidence": []
    },
    "files": [
      {
        "path": ".omi-squad/config/project.yaml",
        "action": "kept"
      },
      {
        "path": ".omi-squad/workflows/onboarding-takeover.yaml",
        "action": "kept"
      },
      {
        "path": ".omi-squad/config/codebase.yaml",
        "action": "kept"
      },
      {
        "path": ".omi-squad/config/onboarding-plan.md",
        "action": "kept"
      }
    ]
  }
}
```

### `doctor --project <root>/.tmp/omi-083/project --distribution Ubuntu-24.04 --json` — exit 6

```text
{
  "schemaVersion": 1,
  "ok": false,
  "exitCode": 6,
  "error": {
    "code": "DOCTOR_FAILED",
    "message": "interop: Requires WSL interop and an accessible WSL_INTEROP socket; distribution-version: Bound distro must be registered as WSL version 2; windows-launch: Windows must reach this project's local shim through typed argv"
  }
}
```

### `status --runtime --json` — exit 3

```text
{
  "schemaVersion": 1,
  "ok": false,
  "exitCode": 3,
  "error": {
    "code": "RUNTIME_UNAVAILABLE",
    "message": "no runtime is listening on <root>/.tmp/omi-083/project/.omi-squad/local/ipc/runtime.sock (EPERM)"
  }
}
```

### `plan --issue 0 --json` — exit 2

```text
{
  "schemaVersion": 1,
  "ok": false,
  "exitCode": 2,
  "error": {
    "code": "USAGE",
    "message": "invalid or missing command arguments"
  }
}
```

### `pause --run missing --json` — exit 2

```text
{
  "schemaVersion": 1,
  "ok": false,
  "exitCode": 2,
  "error": {
    "code": "USAGE",
    "message": "give exactly one of --reason and --reason-stdin"
  }
}
```

### `run --json` — exit 2

```text
{
  "schemaVersion": 1,
  "ok": false,
  "exitCode": 2,
  "error": {
    "code": "USAGE",
    "message": "unknown command 'run'"
  }
}
```

### `retry --json` — exit 2

```text
{
  "schemaVersion": 1,
  "ok": false,
  "exitCode": 2,
  "error": {
    "code": "USAGE",
    "message": "unknown command 'retry'"
  }
}
```

### `sync --json` — exit 2

```text
{
  "schemaVersion": 1,
  "ok": false,
  "exitCode": 2,
  "error": {
    "code": "USAGE",
    "message": "unknown command 'sync'"
  }
}
```

### `login --json` — exit 2

```text
{
  "schemaVersion": 1,
  "ok": false,
  "exitCode": 2,
  "error": {
    "code": "USAGE",
    "message": "unknown command 'login'"
  }
}
```

## Repository checks on this documentation diff

`npm run check` exited 1 in `check:architecture`: dependency-cruiser passed (349 modules,
1,596 dependencies), then `tools/check-structure.ts` failed at `spawnSync git EPERM`.
Typecheck, build, lint and format:check had completed successfully. This is not a passing full
check; the sandbox failure is not waived. The final retry had the same stage/result.

The remaining stages were run separately with `npm run <script>`:

| Stage | Result |
| --- | --- |
| check:backlog | exit 0; 6 milestones, 8 epics, 48 sub-issues consistent |
| schemas:check | exit 0; 10 files |
| prompts:check | exit 0 |
| check:coordinator-source | exit 0; template drift/copy inventory passed |
| test:unit | exit 0; 148 files, 2,112 tests passed |
| test:integration | exit 1; 31 files failed, 41 passed; 281 failed, 528 passed, 5 skipped; 4 errors |
| test:contract | exit 1; 6 files failed, 17 passed; 71 failed, 303 passed |
| test:e2e | exit 1; 9 files failed, 7 passed; 54 failed, 64 passed, 24 skipped |
| pack:check | exit 1; Unexpected end of JSON input parsing npm pack output |

Process/socket/child-output failures and downstream assertions were observed; not every failed
assertion has been independently diagnosed. No code or gate was changed to accommodate them.
`git diff --check` passed; local Markdown links resolve. `git diff --` for
`docs/planning/project-plan.md` and `docs/planning/github-backlog.yaml` is empty.
Live/stress suites were not run. Independent QA/review is pending a fixed committed revision
and Coordinator-provided check evidence from an environment able to run the full check.

Relevant full-check failure tail:

```text
✔ no dependency violations found (349 modules, 1596 dependencies cruised)
Error: spawnSync git EPERM
    at listFiles (.../tools/check-structure.ts:150:18)
  code: 'EPERM', syscall: 'spawnSync git', path: 'git'
Node.js v24.22.2
```

## prepare-pr syntax check — 2026-11-14

The built CLI (`node dist/bootstrap/cli.js prepare-pr --help`, exit 0) now exposes:

```text
Usage: omi-squad prepare-pr [options]

Open or recover the task PR for a finished run and save its mapping

Options:
  --run <id>         run id
  --title <text>     pull request title
  --evidence <text>  one evidence line per AC in order (repeatable) (default:
                     [])
  --json             print one machine-readable JSON document
  --socket <path>    runtime socket path
  -h, --help         display help for command
```

This supplements the historical inventory above. CLI unit coverage preserves repeated evidence
order. The IPC dispatcher integration uses real SQLite/outbox and fake GitHub to prepare/recover
one PR, persist its mapping and deliver to Done; absent or mismatched mappings return
`COMMAND_REFUSED: MAPPING_MISMATCH`. The Unix socket variant is present but this sandbox refuses
`listen` with `EPERM`; successful socket transport and live GitHub delivery remain unverified here.
