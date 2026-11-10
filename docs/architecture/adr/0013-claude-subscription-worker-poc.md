# ADR-0013 — PoC: Claude Code worker on a subscription login

- Status: Proposed — harness built; **live evidence pending** (see Evidence)
- Date: 2026-11-10
- Issue: #3 (OMI-002), epic #1, milestone M0 — Feasibility
- Context documents: `docs/engineering/tech-stack.md` §7, §8, §10; `docs/architecture/architecture.md` §7
- Out of scope: the production adapter (OMI-013), multi-profile isolation and quota/failover
  detection (OMI-004), cross-boundary lifecycle (OMI-005)

## Context

omi-squad runs Claude Code workers non-interactively on the PO's subscription logins, never on a
paid API key (tech-stack.md §8). Before building the adapter we need evidence that `claude -p`
with a subscription profile can read and edit a repository, that its output can be parsed and
classified, and that a run can be cancelled within a bounded time.

## Decision

The PoC is an opt-in live test, not production code:

- `tests/live/claude-code/claude-subscription-worker.test.ts` — the four cases below.
- `tests/live/claude-code/claude-cli-process.ts` — test-only spawn/parse/redact support. The
  OMI-013 adapter in `src/infrastructure/executors/claude-code/` must not import it; it may reuse
  the findings.
- `npm run test:live` runs only `tests/live`. It is not part of `npm run check` or CI.
- No new dependency.

Run: `OMI_LIVE_CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/b npm run test:live`. A missing or
non-directory `OMI_LIVE_CLAUDE_CONFIG_DIR` fails the suite with an explicit message; it never
skips silently.

### Cases

| Case                  | Flags beyond the shared set                                                                         | Pass condition                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| env guard             | —                                                                                                   | child env has no `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN`; `CLAUDE_CONFIG_DIR` = profile; `claude auth status` exits 0      |
| read-only             | `--tools Read,Grep,Glob --allowedTools Read,Grep,Glob --permission-mode dontAsk --max-turns 6`      | result `success`; answer contains the codename from the temp README; no Edit/Write/Bash in `init.tools`; `git status` clean |
| edit                  | `--tools Read,Edit,Write,Glob,Grep --allowedTools (same) --permission-mode acceptEdits --max-turns 8` | result `success`; `greeting.txt` on disk is `Hello, omi`; `git status` shows only `M greeting.txt`                          |
| error (invalid model) | `--tools "" --model omi-nonexistent-model-0 --max-turns 1`                                           | classified `error`: non-zero exit or `result.is_error=true`                                                                 |
| cancel (SIGINT)       | `--tools "" --max-turns 1`, long essay prompt; SIGINT 3 s after the first `system` event             | classified `cancelled`; exit within 15 s of the signal without SIGKILL escalation; no process-group member left at close     |

Every case where the CLI emits its `system/init` event also asserts `apiKeySource == "none"`.

### Flags and why

- **`-p` (print mode), never `--bare`.** `--bare` reads auth strictly from `ANTHROPIC_API_KEY` or an
  `apiKeyHelper` and never reads OAuth (CLI `--help` of 2.1.322), so it cannot use a subscription.
- **`--output-format stream-json --verbose`.** One JSON event per line; `system/init` carries
  `session_id`, `model`, `permissionMode`, `tools` and `apiKeySource`, the final `result` event
  carries `subtype`, `is_error`, `num_turns`, `duration_ms`. Exit code alone is not trusted
  (tech-stack.md §7).
- **Prompt on stdin**, not argv; `spawn(..., { shell: false, detached: true })`. Also avoids the
  variadic `--tools`/`--allowedTools` options swallowing a positional prompt.
- **`--tools` plus `--allowedTools`.** `--tools` limits which built-in tools exist at all;
  `--allowedTools` pre-approves them. Read-only uses `--permission-mode dontAsk` so anything not
  pre-approved is denied instead of waiting for a prompt. The edit step uses `acceptEdits`, never
  `bypassPermissions`/`--dangerously-skip-permissions`.
- **`--no-session-persistence`** keeps PoC transcripts out of the profile directory.
- **`--strict-mcp-config`** with no `--mcp-config` loads no MCP servers from the profile.
- **Allowlisted child env**: only `PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TERM, TMPDIR`
  and proxy variables are inherited, then `CLAUDE_CONFIG_DIR=<profile>` and
  `DISABLE_AUTOUPDATER=1`. This removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN` and the parent session's `CLAUDECODE`/`CLAUDE_CODE_*` variables.
- **Own process group** (`detached: true`): a terminal Ctrl-C does not reach the worker, and the
  group (never a process name) is the SIGKILL target after the grace period (tech-stack.md §7).

### Evidence handling

The test writes, under the gitignored `.tmp/live/`:

- `omi-002-claude-subscription-evidence.json` — versions, OS, child env **key names** only,
  allowlisted `claude auth status` fields (`loggedIn`, `authMethod`, `apiProvider`,
  `apiKeySource`, `subscriptionType` plus the list of field names, never the email/org), and per
  case: outcome, exit code/signal, duration, session id, model, permission mode, `apiKeySource`,
  available and used tool names, result subtype, a redacted 300-character result excerpt, a
  redacted stderr excerpt and cancel timing.
- `omi-002-<case>.events.jsonl` — one line per event with only `type`, `subtype`, tool names and
  result counters; no message bodies.

Text excerpts go through regex redaction (keys, bearer tokens, emails, long opaque strings). Regex
redaction is best effort (tech-stack.md §9); the main protection is that only allowlisted fields
are written.

## Evidence

**Not yet run.** The implementing worker session (2026-11-10, profile `a`) could not execute the
live run: its permission policy requires interactive approval for any command that sets
`OMI_LIVE_CLAUDE_CONFIG_DIR`, and the dispatch was non-interactive. The worker did not bypass
that gate. What was verified:

- `npm run test:live` without `OMI_LIVE_CLAUDE_CONFIG_DIR` fails the suite with
  `Error: OMI_LIVE_CLAUDE_CONFIG_DIR is required for the live Claude Code test…` (exit 1, 0 tests
  run) — the "fail loudly, never skip" rule holds.
- `npm run typecheck`, `npm run lint` and the full `npm run check` pass with the new files.
- Environment seen by the worker: Ubuntu 24.04.5 LTS on WSL2 (kernel 5.15.167.4), Node 24.22.2,
  Git 2.43.0, Claude Code 2.1.322.

To complete this ADR, run the command above on a session allowed to use profile `b`, then
replace this section with the per-case table from
`.tmp/live/omi-002-claude-subscription-evidence.json` (outcome, exit code, duration,
`apiKeySource`, auth method, session ids) and set the status to Accepted, or record each failing
case as not proven.

## Proven / not proven

| Claim                                                         | Status                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Missing profile config fails the live suite loudly            | Proven (local run, 2026-11-10)                            |
| Child env cannot carry an API key or OAuth token              | Proven by construction (allowlist) and by the env-guard case once run |
| Read-only step on subscription login                          | **Not proven yet** — awaiting live run                    |
| Edit step on a temp repo, verified on disk                    | **Not proven yet** — awaiting live run                    |
| Error classification (invalid model)                          | **Not proven yet** — awaiting live run                    |
| Cancel within a bounded time via SIGINT                       | **Not proven yet** — awaiting live run                    |
| `apiKeySource == "none"` means subscription auth              | Assumption — checked against `claude auth status` fields in the evidence |
| Several profiles isolated in parallel; token refresh races    | Out of scope — OMI-004                                    |
| Quota/rate-limit error detection and failover                 | Out of scope — OMI-004                                    |
| Cancel from the Windows Coordinator across the WSL boundary   | Out of scope — OMI-005                                    |
| Cancel of a worker that runs tool subprocesses (Bash)         | Not covered — PoC cancel case has no tools                |

## Risks

- **CLI drift.** stream-json field names (`apiKeySource`, `permissionMode`, `result.subtype`) are
  not a versioned contract. OMI-013 must pin a supported Claude Code range, keep secret-free
  fixtures in `tests/contract/` and re-run this live test on each CLI upgrade.
- **Profile settings still load.** User settings/hooks from the profile directory apply to the
  worker (only MCP servers are excluded). A hook in the profile could change behaviour; OMI-013
  should decide on `--setting-sources` and document it.
- **`-p` skips the workspace trust dialog.** Workers must only run in workspaces the framework
  created (task worktrees), never arbitrary directories.
- **Quota.** Each live run spends subscription quota (five model calls, one deliberately long and
  cancelled). Keep it opt-in.
- **Nested sessions.** Running the test from inside a Claude Code session works only because the
  env allowlist drops `CLAUDECODE`/`CLAUDE_CODE_*`; a production worker must do the same.
