# Compatibility

Versions listed here are only what has actually been checked; nothing else is promised
(tech-stack.md §3). Status values: `supported` (checked with evidence), `untested`,
`unsupported`. A version not listed is `untested`.

## Worker environment (WSL2)

Checked 2026-11-10 by the OMI-002 live run (Coordinator, commit `f141f34`, profile
`~/.claude-profiles/b`). Evidence: ADR-0013 §Evidence; raw redacted files in
`.tmp/live/omi-002-*` on the machine that ran it (gitignored).

| Component   | Version                                                                  | Status    | Checked    | Evidence / scope                                                                 |
| ----------- | ------------------------------------------------------------------------ | --------- | ---------- | -------------------------------------------------------------------------------- |
| OS          | Ubuntu 24.04.5 LTS on WSL2 (kernel 5.15.167.4-microsoft-standard-WSL2)    | supported | 2026-11-10 | Worker + `npm run check` + OMI-002 live run. WSL2 lifecycle across the Windows boundary is OMI-005 |
| Node.js     | 24.22.2                                                                  | supported | 2026-11-10 | `.nvmrc`; `npm run check` and OMI-002 live run                                   |
| Git         | 2.43.0                                                                   | supported | 2026-11-10 | Temp repo init/commit/status in the OMI-002 live run; worktree flows untested    |
| gh          | 2.103.3 (2026-10-26)                                                     | untested  | 2026-11-10 | Version recorded only; no gh operation exercised by OMI-002                      |
| Claude Code | 2.1.322                                                                  | supported | 2026-11-10 | `claude -p` worker: read, edit, error, SIGINT cancel (ADR-0013). Single profile, one run |
| Codex CLI   | —                                                                        | untested  | —          | OMI-003                                                                          |

## Claude Code auth mode

| Mode                                                                 | Status      | Notes                                                                                                   |
| -------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| Subscription login (`authMethod: claude.ai`, `apiProvider: firstParty`, plan `pro`) via a `CLAUDE_CONFIG_DIR` profile, `claude -p` | supported   | One profile, sequential runs; `init.apiKeySource: none` in every run (ADR-0013)                        |
| `--bare` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` | unsupported | Excluded by design (tech-stack.md §8); the live test strips them from the child env                    |
| Several profiles in parallel, concurrent token refresh               | untested    | OMI-004                                                                                                 |
| Quota/rate-limit detection                                           | untested    | OMI-004                                                                                                 |

Note: the default model is a per-profile property (profile `b`: `claude-sonnet-5-5`; another
profile on the same machine: `claude-opus-5-5`). Do not infer it from the Claude Code version.

## Coordinator environment (Windows)

| Component | Version | Status   | Checked | Evidence                       |
| --------- | ------- | -------- | ------- | ------------------------------ |
| Windows   | 11      | untested | —       | ADR-0012; verified by OMI-005  |

## How to re-check

- Claude Code worker: `OMI_LIVE_CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/<id> npm run test:live`,
  then read `.tmp/live/omi-002-claude-subscription-evidence.json` and update the rows above with
  the date and versions it records. Never paste the raw event stream or auth output here.
