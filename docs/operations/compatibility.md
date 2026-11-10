# Compatibility

Versions listed here are only what has actually been checked; nothing else is promised
(tech-stack.md §3). Status values: `supported` (checked with evidence), `untested`,
`unsupported`. A version not listed is `untested`.

## Worker environment (WSL2)

| Component   | Version                                 | Status    | Checked    | Evidence                                    |
| ----------- | --------------------------------------- | --------- | ---------- | ------------------------------------------- |
| OS          | Ubuntu 24.04.5 LTS on WSL2 (kernel 5.15.167.4-microsoft-standard-WSL2) | untested | 2026-11-10 | Seen by the OMI-002 worker; WSL2 baseline is verified by OMI-005 |
| Node.js     | 24.22.2                                 | supported | 2026-11-10 | `.nvmrc`; `npm run check` green (OMI-002)   |
| Git         | 2.43.0                                  | untested  | 2026-11-10 | Used by the OMI-002 live test for the temp repo; awaiting live run |
| gh          | not recorded yet                        | untested  | —          | The live test records it in its evidence file |
| Claude Code | 2.1.322                                 | untested  | 2026-11-10 | ADR-0013; live run pending                  |
| Codex CLI   | —                                       | untested  | —          | OMI-003                                     |

## Claude Code auth mode

| Mode                                                | Status      | Notes                                                              |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| Subscription login via `CLAUDE_CONFIG_DIR` profile, `claude -p` | untested | ADR-0013 harness ready; live evidence pending                      |
| `--bare` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | unsupported | Excluded by design (tech-stack.md §8); the live test strips them |
| Several profiles in parallel                        | untested    | OMI-004                                                            |

## Coordinator environment (Windows)

| Component | Version | Status   | Checked | Evidence                       |
| --------- | ------- | -------- | ------- | ------------------------------ |
| Windows   | 11      | untested | —       | ADR-0012; verified by OMI-005  |

## How to re-check

- Claude Code worker: `OMI_LIVE_CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/<id> npm run test:live`,
  then read `.tmp/live/omi-002-claude-subscription-evidence.json` and update the rows above with
  the date and versions it records. Never paste the raw event stream or auth output here.
