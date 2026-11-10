# Compatibility

Versions listed here are only what has actually been checked; nothing else is promised
(tech-stack.md §3). Status values: `supported` (checked with evidence), `untested`,
`unsupported`. A version not listed is `untested`.

## Worker environment (WSL2)

Checked 2026-11-10 by the OMI-002 live runs (Coordinator, profile `~/.claude-profiles/b`): first
on commit `f141f34`, then re-run with the tightened assertions on `b0ab3b3` (merged head of
PR #60), 5/5 passed both times. Evidence: ADR-0013 §Evidence, the PR #60 body and its
independent review comment; raw redacted files in `.tmp/live/omi-002-*` on the machine that ran
it (gitignored).

| Component   | Version                                                                  | Status    | Checked    | Evidence / scope                                                                 |
| ----------- | ------------------------------------------------------------------------ | --------- | ---------- | -------------------------------------------------------------------------------- |
| OS          | Ubuntu 24.04.5 LTS on WSL2 (kernel 5.15.167.4-microsoft-standard-WSL2)    | supported | 2026-11-10 | Worker + `npm run check` + OMI-002 live run. WSL2 lifecycle across the Windows boundary is OMI-005 |
| Node.js     | 24.22.2                                                                  | supported | 2026-11-10 | `.nvmrc`; `npm run check` and OMI-002 live run                                   |
| Git         | 2.43.0                                                                   | supported | 2026-11-10 | Temp repo init/commit/status in the OMI-002 live run; worktree flows untested    |
| gh          | 2.103.3 (2026-10-26)                                                     | untested  | 2026-11-10 | Version recorded only; no gh operation exercised by OMI-002                      |
| Claude Code | 2.1.322                                                                  | supported | 2026-11-10 | `claude -p` worker: read, edit, error, SIGINT cancel (ADR-0013). Single profile, two runs |
| Codex CLI   | 0.167.0                                                                  | untested  | 2026-11-10 | Version/auth guard only; worker startup failed in sandbox (ADR-0021)              |

## Claude Code auth mode

| Mode                                                                 | Status      | Notes                                                                                                   |
| -------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| Subscription login (`authMethod: claude.ai`, `apiProvider: firstParty`, plan `pro`) via a `CLAUDE_CONFIG_DIR` profile, `claude -p` | supported   | One profile, sequential runs; `init.apiKeySource: none` in every run (ADR-0013)                        |
| `--bare` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` | unsupported | Excluded by design (tech-stack.md §8); the live test strips them from the child env                    |
| Several profiles in parallel, concurrent token refresh               | untested    | OMI-004                                                                                                 |
| Quota/rate-limit detection                                           | untested    | OMI-004                                                                                                 |

Note: the default model is a per-profile property (profile `b`: `claude-sonnet-5-5`; another
profile on the same machine: `claude-opus-5-5`). Do not infer it from the Claude Code version.

## Codex CLI subscription worker

OMI-003 adds a test-only harness for Codex CLI **0.167.0**. The 2026-11-10 sandbox attempt
validated the version, a `chatgpt` file cache and a child environment without API keys. Read-only
and cancel invocations exited 1 before emitting JSONL; edit was not reached. The initial error
case passed a duplicate schema option and its exit 2 is inconclusive. The corrected harness has
not been rerun live. See [ADR-0021](../architecture/adr/0021-codex-subscription-worker-poc.md) for
observations, the command used, and the distinction between offline checks and subscription evidence.

| Mode / capability | Status | Notes |
| --- | --- | --- |
| ChatGPT subscription, file store under explicit WSL `CODEX_HOME` | untested | Cache shape validated; successful authenticated execution and durable refresh not proven |
| Read-only then edit with schema output | untested | Final harness awaits an outside-sandbox run |
| Real CLI schema error / SIGINT cancel | untested | Offline fake-process tests pass; real behavior not proven |
| API key (`OPENAI_API_KEY`, `CODEX_API_KEY`, cached API key) | unsupported | Excluded by design and guarded in tests |
| OS keyring, concurrent profiles/refresh, quota failover | untested | OMI-004; separate cache directories do not imply separate quotas |

Coordinator command (outside the worker sandbox, from this repo):

```sh
OMI_LIVE_CODEX_HOME="$HOME/.codex-profiles/ggtintran" \
  npx vitest run tests/live/codex-cli/codex-subscription-worker.test.ts
```

Read `.tmp/live/omi-003-codex-subscription-evidence.json` and `omi-003-*.events.jsonl` on the
machine running the test. Require `allChecksPassed: true` and per-case checks before recording
support. This command selects Codex alone. `npm run test:live -- <file>` also selects the Claude
suite and requires its profile variable. Without `OMI_LIVE_CODEX_HOME`, the Codex suite skips;
with an invalid or empty value it fails. Live tests remain outside `npm run check` and CI.

## Coordinator environment (Windows)

| Component | Version | Status   | Checked | Evidence                       |
| --------- | ------- | -------- | ------- | ------------------------------ |
| Windows   | 11      | untested | —       | ADR-0012; verified by OMI-005  |

## How to re-check

- Claude Code worker: `OMI_LIVE_CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/<id> npm run test:live`,
  then read `.tmp/live/omi-002-claude-subscription-evidence.json` and update the rows above with
  the date and versions it records. Never paste the raw event stream or auth output here.
