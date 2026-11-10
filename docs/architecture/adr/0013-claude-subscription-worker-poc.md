# ADR-0013 — PoC: Claude Code worker on a subscription login

- Status: Accepted — all four OMI-002 acceptance criteria evidenced by a live run on 2026-11-10
- Date: 2026-11-10
- Issue: #3 (OMI-002), epic #1, milestone M0 — Feasibility
- Context documents: `docs/engineering/tech-stack.md` §7, §8, §10; `docs/architecture/architecture.md` §7
- Out of scope: the production adapter (OMI-013), multi-profile isolation, concurrency and
  quota/failover detection (OMI-004), cross-boundary lifecycle (OMI-005), capability selection
  (OMI-015)

## Context

omi-squad runs Claude Code workers non-interactively on the PO's subscription logins, never on a
paid API key (tech-stack.md §8). Before building the adapter we need evidence that `claude -p`
with a subscription profile can read and edit a repository, that its output can be parsed and
classified, and that a run can be cancelled within a bounded time.

## Decision

The PoC is an opt-in live test, not production code:

- `tests/live/claude-code/claude-subscription-worker.test.ts` — the cases below.
- `tests/live/claude-code/claude-cli-process.ts` — test-only spawn/parse/redact support. The
  OMI-013 adapter in `src/infrastructure/executors/claude-code/` must not import it; it may reuse
  the findings.
- `npm run test:live` runs only `tests/live`. It is not part of `npm run check` or CI.
- No new dependency.

Run: `OMI_LIVE_CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/b npm run test:live`. A missing or
non-directory `OMI_LIVE_CLAUDE_CONFIG_DIR` fails the suite with an explicit message; it never
skips silently.

### Cases

| Case                  | Flags beyond the shared set                                                                           | Pass condition                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| env guard             | —                                                                                                     | child env has no `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN`; `CLAUDE_CONFIG_DIR` = profile; `claude auth status` exits 0 with `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty` |
| read-only             | `--tools Read,Grep,Glob --allowedTools Read,Grep,Glob --permission-mode dontAsk --max-turns 6`        | result `success`; answer contains the codename from the temp README; no Edit/Write/Bash in `init.tools`; only Read/Grep/Glob used; `git status` clean                          |
| edit                  | `--tools Read,Edit,Write,Glob,Grep --allowedTools (same) --permission-mode acceptEdits --max-turns 8` | result `success`; `permissionMode=acceptEdits`; `greeting.txt` on disk is `Hello, omi`; `git status` shows only `M greeting.txt`                                               |
| error (invalid model) | `--tools "" --model omi-nonexistent-model-0 --max-turns 1`                                             | classified `error`; non-zero exit **and** `result.is_error=true`                                                                                                              |
| cancel (SIGINT)       | `--tools "" --max-turns 1`, long essay prompt; SIGINT 3 s after the `system/init` event               | classified `cancelled`; `result.is_error=true`; exit within 15 s of the signal without SIGKILL escalation; no process-group member left at close                               |

Every model case also asserts `init.apiKeySource == "none"`.

Classification: **success = exit 0 and `result.subtype == "success"` and `result.is_error != true`.**
A cancel requested by the caller that does not end in success is `cancelled`; everything else is
`error`. The live run showed that neither the exit code nor the subtype is enough alone (see
Findings).

### Flags and why

- **`-p` (print mode), never `--bare`.** `--bare` reads auth strictly from `ANTHROPIC_API_KEY` or an
  `apiKeyHelper` and never reads OAuth (CLI `--help` of 2.1.322), so it cannot use a subscription.
- **`--output-format stream-json --verbose`.** One JSON event per line; `system/init` carries
  `session_id`, `model`, `permissionMode`, `tools` and `apiKeySource`, the final `result` event
  carries `subtype`, `is_error`, `num_turns`, `duration_ms`. Exit code alone is not trusted
  (tech-stack.md §7).
- **Prompt on stdin**, not argv; `spawn(..., { shell: false, detached: true })`. Also avoids the
  variadic `--tools`/`--allowedTools` options swallowing a positional prompt.
- **`--tools` plus `--allowedTools`.** `--tools` limits which built-in tools exist at all (the live
  `init.tools` lists were exactly the requested sets); `--allowedTools` pre-approves them.
  Read-only uses `--permission-mode dontAsk` so anything not pre-approved is denied instead of
  waiting for a prompt. The edit step uses `acceptEdits`, never
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

The test writes, under the gitignored `.tmp/live/` (never committed):

- `omi-002-claude-subscription-evidence.json` — versions, OS, child env **key names** only,
  allowlisted `claude auth status` fields (`loggedIn`, `authMethod`, `apiProvider`,
  `subscriptionType`, `planTier` plus the list of field names; never `email`, `orgId`,
  `orgName`), and per case: outcome, exit code/signal, duration, session id, model, permission
  mode, `apiKeySource`, available and used tool names, result subtype, a redacted 300-character
  result excerpt, a redacted stderr excerpt and cancel timing.
- `omi-002-<case>.events.jsonl` — one line per event with only `type`, `subtype`, tool names and
  result counters; no message bodies.

Text excerpts go through regex redaction (keys, bearer tokens, emails, long opaque strings). Regex
redaction is best effort (tech-stack.md §9); the main protection is that only allowlisted fields
are written.

## Evidence

Live run by the **Coordinator** on 2026-11-10 (07:30:13–07:30:35 UTC) at commit `f141f34`, branch
`task/omi-002-claude-subscription-poc`, profile `~/.claude-profiles/b`:
`OMI_LIVE_CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/b npm run test:live` → exit 0, 5/5 tests
passed. Source: `.tmp/live/omi-002-claude-subscription-evidence.json` and
`.tmp/live/omi-002-*.events.jsonl` (gitignored, not committed).

Environment: Ubuntu 24.04.5 LTS on WSL2 (kernel 5.15.167.4-microsoft-standard-WSL2), Node
v24.22.2, Git 2.43.0, gh 2.103.3 (2026-10-26), Claude Code 2.1.322.

Child env keys: `CLAUDE_CONFIG_DIR, DISABLE_AUTOUPDATER, HOME, LANG, LOGNAME, PATH, SHELL, TERM,
USER`; forbidden auth variables present in the child: none.

`claude auth status --json` (allowlisted fields): exit 0, `loggedIn: true`,
`authMethod: "claude.ai"`, `apiProvider: "firstParty"`, `subscriptionType: "pro"`. The command
reports no `apiKeySource` field; the full field list was `analyticsDisabled, apiProvider,
authMethod, configDirectory, email, loggedIn, loginExpiresAt, orgId, orgName, planTier,
projectsDirectory, storedClaudeAiLogin, subscriptionType`.

| Case                | Outcome   | Exit | Duration | Model                     | `apiKeySource` | Permission mode | Tools available → used         | Result                                                   |
| ------------------- | --------- | ---- | -------- | ------------------------- | -------------- | --------------- | ------------------------------ | -------------------------------------------------------- |
| read-only           | success   | 0    | 5.5 s    | `claude-sonnet-5-5`       | `none`         | `dontAsk`       | Glob, Grep, Read → Read        | `success`, 2 turns, answer `BLUE-HERON-42`, git clean    |
| edit                | success   | 0    | 9.5 s    | `claude-sonnet-5-5`       | `none`         | `acceptEdits`   | Edit, Glob, Grep, Read, Write → Read, Edit | `success`, 3 turns, file `Hello, omi`, git ` M greeting.txt` |
| error-invalid-model | error     | 1    | 2.5 s    | `omi-nonexistent-model-0` | `none`         | `default`       | none                           | subtype `success` **with** `is_error: true`; stderr `[claude-code:unrecognized_model]` |
| cancel-sigint       | cancelled | 0    | 4.2 s    | `claude-sonnet-5-5`       | `none`         | `default`       | none                           | subtype `error_during_execution`, `is_error: true`       |

Cancel detail: SIGINT sent 3281 ms after spawn, process exited 939 ms later on its own (no SIGKILL
escalation, `signal: null`, exit code 0); no member of its process group was alive at close. Event
sequence: `system/hook_started`, `system/hook_response`, `system/init`, `system/thinking_tokens`,
`user`, `result/error_during_execution`.

Session ids (for tracing only): read-only `83503487-8b3c-45be-9574-987fa4ac5a92`, edit
`605cfb14-bde1-4674-bf33-9768e0e24613`, error `68819fbf-e70b-462e-a954-3e43f06dd886`, cancel
`75578569-2a96-442d-89f8-f7cf521695a7`.

Earlier, without `OMI_LIVE_CLAUDE_CONFIG_DIR`, `npm run test:live` failed the suite with
`Error: OMI_LIVE_CLAUDE_CONFIG_DIR is required for the live Claude Code test…` (exit 1, 0 tests).

### Findings

1. **Exit code and subtype are each unreliable alone.** An unknown model returned
   `result.subtype: "success"` with `is_error: true` (exit 1); a SIGINT-cancelled run exited **0**
   with `subtype: "error_during_execution"`. OMI-013 must use exit code + `subtype` + `is_error`
   together and track whether it requested the cancel itself.
2. **SIGINT is a clean, fast cancel** for a tool-less run: the CLI still emits a final `result`
   event and exits within ~1 s.
3. **Profile hooks run in `-p` mode.** Every run on profile `b` emitted
   `system/hook_started` and `system/hook_response` before `init`, i.e. a hook configured
   for that profile ran. The cancel trigger therefore now waits
   for `system/init`, not the first `system` event (see Changes after the run).
4. **The default model differs per profile.** Profile `b` ran `claude-sonnet-5-5` with no
   `--model`; profile `a` (the implementing worker's own session) runs `claude-opus-5-5`. A
   worker's model must not be assumed from the tool alone: OMI-013 should pass `--model`
   explicitly and read `init.model` back, and OMI-015 capability selection must treat the model as
   a per-profile property.
5. **Auth mode is visible in two places.** `init.apiKeySource == "none"` agreed with
   `claude auth status` → `authMethod: "claude.ai"`, `apiProvider: "firstParty"`. `auth status`
   also exposes `loginExpiresAt`, useful for the `login-required` state in OMI-004.
6. **Unknown model is detected before any model call** (stderr tag
   `[claude-code:unrecognized_model]`, 2.5 s), so invalid config can be classified separately from
   quota/network errors (architecture.md §7 failover step 1).

### Changes after the run

Made after `f141f34` from the findings above, in the follow-up commit. They are **not yet re-run
live**; every new assertion holds for the values recorded in this run:

- Cancel trigger matches `system/init` instead of any `system` event (in this run SIGINT still
  landed after `init`, because the hooks finished within the 3 s delay).
- Env guard asserts `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`.
- Error case asserts non-zero exit **and** `is_error=true` (was "either"), and `apiKeySource=none`
  unconditionally.
- Cancel case asserts `apiKeySource=none` and `result.is_error=true`.
- `auth status` allowlist drops the non-existent `apiKeySource` and keeps `planTier`.

## Acceptance criteria (Issue #3)

| AC                                                         | Status    | Evidence                                                                            |
| ---------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| 1. Read-only step, then an edit step on a temp repo via CLI subscription | Evidenced | read-only and edit cases above; file verified on disk, git status checked         |
| 2. Version, auth mode and logs recorded, secrets removed   | Evidenced | evidence JSON + events JSONL: versions, `authMethod`, allowlisted fields only      |
| 3. Success, error and cancel cases checked                 | Evidenced | success ×2, error (exit 1, `is_error`), cancel (SIGINT, 939 ms, no escalation)     |
| 4. No API key as a substitute                              | Evidenced | no `ANTHROPIC_*` in child env; `apiKeySource: none` in all 4 runs; `authMethod: claude.ai` |

## Proven / not proven

| Claim                                                         | Status                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Missing profile config fails the live suite loudly            | Proven                                                    |
| Child env carries no API key or OAuth token                   | Proven (allowlist + env-guard case)                       |
| Read-only step on a subscription login                        | Proven (one run, one profile)                             |
| Edit step on a temp repo, verified on disk                    | Proven (one run, one profile)                             |
| Error classification (invalid model)                          | Proven                                                    |
| Cancel of a tool-less run via SIGINT within a bounded time    | Proven                                                    |
| `apiKeySource == "none"` corresponds to a subscription login  | Corroborated by `auth status` (`authMethod: claude.ai`) on profile `b` |
| Several profiles isolated in parallel; concurrent token refresh | **Not proven** — OMI-004                                |
| Real quota/rate-limit detection and failover                  | **Not proven** — OMI-004 (only an invalid-model error was exercised) |
| Concurrency (more than one worker at a time)                  | **Not proven** — OMI-004                                  |
| Cancel of a worker running tool subprocesses (Bash)           | **Not proven** — the cancel case has no tools             |
| Cancel from the Windows Coordinator across the WSL boundary   | **Not proven** — OMI-005                                  |
| Repeatability across runs / other Claude Code versions        | **Not proven** — one run on 2.1.322                       |
| The post-run test changes (see above)                         | Not re-run live yet                                       |

## Risks

- **CLI drift.** stream-json field names (`apiKeySource`, `permissionMode`, `result.subtype`) and
  their semantics (e.g. `subtype: success` with `is_error: true`) are not a versioned contract.
  OMI-013 must pin a supported Claude Code range, keep secret-free fixtures in `tests/contract/`
  and re-run this live test on each CLI upgrade.
- **Profile settings and hooks still load.** The run proved that profile hooks execute in `-p`
  mode (only MCP servers are excluded). A hook can change behaviour or timing; OMI-013 should
  decide on `--setting-sources` and document it.
- **Per-profile defaults** (model, possibly effort/settings) make two profiles behave differently
  for the same task unless the adapter pins them.
- **`-p` skips the workspace trust dialog.** Workers must only run in workspaces the framework
  created (task worktrees), never arbitrary directories.
- **Quota.** Each live run spends subscription quota (four model sessions, one cancelled). Keep it
  opt-in.
- **Nested sessions.** Running the test from inside a Claude Code session works only because the
  env allowlist drops `CLAUDECODE`/`CLAUDE_CODE_*`; a production worker must do the same.
