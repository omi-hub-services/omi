# ADR-0023 — AgentExecutor port and the production Claude Code adapter

- Status: Accepted (contract-tested against fixtures and a fake CLI; **not yet re-run live**, see
  "Not proven")
- Date: 2026-11-11
- Issue: #16 (OMI-013), epic #15, milestone M2 — Execution
- Context: architecture.md §3, §7, §14; design-patterns.md §2; tech-stack.md §7–§9; ADR-0013
  (Claude PoC), ADR-0016 (contracts), ADR-0021 (Codex PoC), ADR-0022
- Follow-up that consumes this: OMI-014 (Codex adapter), OMI-015 (selection), OMI-004 (quota and
  failover)

## Context

ADR-0013 proved that `claude -p` on a subscription profile can read and edit a repository and
listed what the production adapter must do with the findings. ADR-0021 did the same for Codex.
Neither fixed the port the use cases will call, the supported CLI versions, or the settings
policy. This ADR records those choices so OMI-014 builds the same port.

## Decision

### 1. Port: five operations, neutral types in `contracts/`

`src/application/ports/agent-executor.ts` declares `AgentExecutor` with `probe`, `start`, `events`,
`cancel`, `collectResult`. Its types live in `src/application/contracts/agent-execution.ts` (Zod,
inferred types), as design-patterns.md §2 asks: adapters do not redeclare them. Nothing in either
file names a Claude or Codex flag, event or file.

| Operation       | Shape                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`         | `{ profileHome }` → `{ status, version?, compatibility, supportedRange, subscriptionType?, loginExpiresAt?, diagnostic? }`. Resolves for every CLI state; rejects only for an invalid request. |
| `start`         | `ExecutionRequest` → `ExecutionHandle`. Resolves when the process exists. Rejects with `AgentExecutorError` (`INVALID_REQUEST`, `SPAWN_FAILED`).  |
| `events`        | `AsyncIterable<ExecutionEvent>`, replayable from the first event, completes after a `finished` event.                                           |
| `cancel`        | Polite signal, then the process group after a grace period. Idempotent; no-op after the run finished. Resolves when the process has exited.     |
| `collectResult` | `ExecutionResult`, idempotent.                                                                                                                  |

- **Request**: `attemptId`, `workspace`, `profileHome`, `prompt` (stdin), `model` (always explicit,
  ADR-0013 finding 4), `effort`, `access`, `timeoutMs`. Strict object: an extra field (a smuggled
  flag or key) is rejected. `model` uses the existing plain-model-name rule, so it can never be
  parsed as a flag.
- **`profileHome`** is the profile's isolated state directory (Claude `CLAUDE_CONFIG_DIR`, Codex
  `CODEX_HOME`). The profile is selected per call; the adapter never switches or rewrites a global
  login, so runs on different profiles may overlap.
- **`access`**: `read-only` | `workspace-write`. Adapters translate; use cases never see tools or
  permission modes. A level that runs shell commands is **deliberately absent** (see Open
  decisions).
- **Handle**: `{ executionId, attemptId, executor }`, neutral ids; valid only for the adapter that
  issued it.
- **Events** carry no message text, tool input or tool output: `started`, `tool-use`,
  `quota-signal`, `diagnostic` (`unparsed-output`), `finished`. The buffer is bounded; `finished`
  is always appended.
- **Result**: `outcome` ∈ `succeeded | cancelled | timed-out | usage-limit | auth-required |
  unsupported-model-or-effort | malformed-output | failed`, a stable `reason` code, exit code and
  signal, `model` and `effort` as `{ requested, actual? }`, `authMode`
  (`subscription | api-key | unknown`), tools used, counters, a redacted bounded `diagnostic`,
  `quota` (`limitType`, `resetsAt`) for a limit, and `escalated` / `leftoverProcessesKilled`.
  `finalMessage` is set only on `succeeded`. The result reports process facts; `succeeded` never
  makes a task Done (architecture.md §6).

These contracts are internal to the runtime, not a file or wire format, so they are **not** in the
generated JSON Schema catalog.

### 2. A shared process layer in `src/infrastructure/processes/`

architecture.md §3 assigns process groups, stdout/stderr, cancellation and timeout to this
directory. OMI-013 adds `supervised-process.ts` (spawn, line framing, limits, cancel, timeout),
`run-command.ts` (short probes on the same code) and `redact-diagnostic.ts`, so the Codex adapter
reuses them instead of copying PoC code (AGENTS.md §1.4):

- own process group (`detached`), `shell: false`, prompt on stdin, the complete child env passed
  in (nothing inherited implicitly);
- cancel = SIGINT to the child, then SIGKILL of the **group only if it is still alive** after the
  grace period (default 15 s); group members left behind after the child exits are killed at close
  and reported;
- a max run time acts like a cancel and is reported as `timed-out`; a stdout or line limit kills
  the group immediately;
- durations use `performance.now()` (the WSL2 wall clock jumped in OMI-002).

The ADR-0013 rule "the adapter must not import the PoC support code" holds: this is new code that
promotes the findings.

### 3. Claude Code invocation

```text
claude -p --output-format stream-json --verbose --no-session-persistence --strict-mcp-config
  --setting-sources project,local --model <m> --effort <e>
  --tools <set> --allowedTools <set> --permission-mode <mode>        # prompt on stdin
```

| `access`          | tools / allowed tools        | permission mode |
| ----------------- | ---------------------------- | --------------- |
| `read-only`       | `Read,Grep,Glob`             | `dontAsk`       |
| `workspace-write` | `Read,Edit,Write,Glob,Grep`  | `acceptEdits`   |

No `--bare` (never reads the subscription login), no `bypassPermissions`. These are exactly the
tool sets proven in ADR-0013.

**Environment** is an allowlist: `PATH HOME USER LOGNAME SHELL LANG LC_ALL TERM TMPDIR` and the
proxy variables in upper **and lower** case, then `CLAUDE_CONFIG_DIR=<profileHome>` and
`DISABLE_AUTOUPDATER=1`. `ANTHROPIC_*`, `CLAUDE_CODE_*` and `CLAUDECODE` are never inherited.

**`--setting-sources project,local` (decision, ADR-0013 risk "profile settings and hooks still
load").** The `user` source is the profile's own `settings.json`; its hooks ran inside `-p`
(finding 3) and its default model differed per profile (finding 4). Loading only the task
worktree's layers makes two profiles behave the same for the same request, while CLAUDE.md and
project settings of the framework-created worktree still apply. The set is an adapter option
(`settingSources`), so it can be widened without a code change. **This default has not been run
against a real CLI**; if a live run shows that omitting `user` breaks login or a needed setting,
change the default here and in this ADR.

### 4. Supported Claude Code versions

`>=2.1.322 <2.2.0`. 2.1.322 is the only version with live evidence (ADR-0013, two runs). The upper
bound accepts later patch releases of the same minor on the assumption that stream-json fields
stay stable within a minor; that assumption is untested and is why the range is a half-open
minor, not "any 2.x". `probe` reports `unsupported-version` (and does not read login status) for a
version outside the range, and `compatibility: "unknown"` (also `unsupported-version`, fail
closed) for output it cannot read. `start` does not re-probe: the profile registry's probe TTL
(architecture.md §7) is the gate. Widening the range requires re-running the live test and
refreshing `tests/fixtures/executors/claude-code/` on the new version.

### 5. Classification

Exit code, `result.subtype` and `result.is_error` are read together (ADR-0013 finding 1).

1. stdout limit exceeded → `failed` (`output_limit_exceeded`).
2. **Success** = exit 0, no signal, `subtype == "success"`, `is_error == false`. Then, still:
   any unparsable stdout line → `malformed-output`; no `init` event → `malformed-output`;
   `init.apiKeySource` present and not `none` → `failed` (`api_key_auth_detected`, tech-stack.md §8).
   Otherwise `succeeded`.
3. Not success, in this order: caller requested cancel → `cancelled`; time limit → `timed-out`;
   unknown model → `unsupported-model-or-effort`; invalid or unsupported effort → same outcome,
   reason `unsupported_effort`; login → `auth-required`; quota → `usage-limit` (with `quota`);
   a bad or missing `result` event → `malformed-output`; otherwise `failed`.

Model, login and quota errors are tested before "malformed" so an ordinary failure is not mistaken
for CLI drift, and a model error is never reported as a quota or login error (architecture.md §7
failover step 1; Issue #16 scope). A strict success rule means one stray non-JSON stdout line
fails an otherwise good run; that is deliberate fail-closed behaviour on CLI drift and matches the
Codex PoC rule.

Evidence behind each rule:

| Rule                                                       | Evidence                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| success; unknown model (`subtype` success + `is_error`, exit 1, stderr `unrecognized_model`); SIGINT cancel (exit 0, `error_during_execution`) | **Recorded** — OMI-002 live run   |
| usage limit (rejected rate-limit event, 429, message text, legacy `\|epoch`), login (401, "not logged in"), invalid effort | **Synthetic** — CLI wording, no real capture; the fixtures say so |
| `init.effort` as the effective effort                      | **Hypothetical** — OMI-002 did not show the field; read only if present and valid |

Diagnostics are redacted (keys, JWTs, bearer tokens, e-mails, long tokens), whitespace-collapsed
and capped at 500 characters; raw stdout or stderr is never stored in a result.

### 6. Tests

`tests/contract/executors/claude-code/` drives the real adapter against a **fake `claude`
executable** that replays secret-free fixtures and records argv, cwd, env keys and stdin. It never
starts the real CLI. `npm run test:contract` is new and is part of `npm run check` and CI: until
now `check` ran only unit and integration tests, so a contract suite would not have been enforced.
The supervisor has integration tests with real child processes under `tests/integration/processes/`.

## How the port fits Codex (ADR-0021)

| Port element                 | Codex mapping                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `profileHome`                | `CODEX_HOME` per process; auth validated in memory (`chatgpt` only), no API key in the child env         |
| `probe`                      | `codex --version`, auth cache mode; same statuses (`login-required`, `unsupported-auth-mode`, …)        |
| `start` / `prompt`           | `codex exec … -C <workspace> -` with the prompt on stdin                                                |
| `access`                     | `read-only` → `-s read-only`; `workspace-write` → `-s workspace-write`                                  |
| `model` / `effort`           | `-m` / a `-c` reasoning-effort override; an effort the CLI lacks (e.g. `max`) → `unsupported-model-or-effort` |
| `events`                     | `thread.started`→`started`, `item.*` commands/tools→`tool-use`, rate-limit data→`quota-signal`, `turn.completed`/`turn.failed`/`error` → classification |
| `cancel`                     | SIGINT then group SIGKILL (proven in ADR-0021: 65 ms)                                                   |
| `collectResult`              | exit 0 + `turn.completed` + no error event + no unparsed output; final message from `-o` file → `finalMessage` |

The effort list in the contract originated with Claude (ADR-0016). The OMI-014 amendment below
maps its shared levels without changing the application contract.

## OMI-014 amendment: production Codex adapter (2026-11-11, Issue #17)

### Contract and invocation

`CodexExecutor` implements the same five-operation port under the already mapped
`src/infrastructure/executors/codex/` directory. No application or generated-schema changes,
new dependencies or structure exceptions are required. JSONL event envelopes, cache fields,
config flags and classifier types remain in infrastructure. It reuses `supervised-process`,
`run-command` and diagnostic redaction. A bounded `ExecutionEventStream` in `processes/` now
owns replay/sequence/terminal-event handling for **both** adapters, preserving the Claude
adapter's behavior instead of copying that implementation.

The ADR-0021 invocation is retained, without the PoC-specific output schema (schema validation
belongs to the consuming use case). Model and effort are always explicit:

```text
codex exec --ignore-user-config --ignore-rules --ephemeral --json --color never
  -c cli_auth_credentials_store="file" -c forced_login_method="chatgpt"
  -c model_provider="openai" -c approval_policy="never"
  -m <model> -c model_reasoning_effort=<effort>
  -C <workspace> -s <read-only|workspace-write> -o <temporary-message-file> -
```

Prompt goes over stdin. The output file lives in a private OS-temp directory, outside the
worktree and profile; a bounded regular UTF-8 file is required for success. Missing, oversized,
invalid UTF-8, directory and symlink outputs fail closed. Cleanup completes before the result
and terminal event, including on cancel/error; failed cleanup is a failed attempt. Spawn failure
also removes the directory. Final output stays plain text, capped at 100,000 characters.

**Effort decision:** retain the existing ordered `low | medium | high | xhigh | max` contract.
Map each spelling identically to `model_reasoning_effort`; do not downgrade `max` to `xhigh`
or claim equivalent capabilities. The selector's verified model declaration determines which
levels it may choose. CLI/model rejection (including an unsupported `max`) is
`unsupported-model-or-effort`, reason `unsupported_effort`. Codex-only levels below `low`
or above `max` are outside this contract until a capability decision requires them. This
preserves Claude validation/ranking and avoids adding tool-specific types to application.
Current [official configuration documentation](https://learn.chatgpt.com/docs/config-file/config-reference)
also describes reasoning effort as dependent on the model and client; it is not evidence that
every level works on the pinned CLI/profile.

`model.requested` and `effort.requested` always record the explicit attempt configuration.
`actual` is set only for valid optional `model`/`model_reasoning_effort` fields reported on
`thread.started`. Those fields are hypothetical extensions, **not observed in ADR-0021**;
ordinary streams leave `actual` absent. There is no inference of effective settings from the
request. Verified effective model/effort reporting remains a live-validation limitation.

### Version and auth namespace

Support exactly `>=0.167.0 <0.167.1` (the single version proven by ADR-0021). Unlike Claude's
minor range, no untested patch release is accepted. Probe runs `codex --version` first; an
unknown, prerelease or unsupported version skips auth inspection and fails closed. Widening
requires live evidence and fixture review. `start` relies on the caller's probe TTL, as Claude
does; it does not spend a second version probe per attempt.

Every child receives an allowlisted environment with its own `CODEX_HOME`. Parent credentials,
session state and provider overrides are absent. Both probe and start validate only the
bounded file cache in memory: `auth_mode=chatgpt`, nonempty access/refresh tokens, no API key
(including mixed caches). Invalid profile credentials make `start` reject `INVALID_REQUEST`
before spawning; probe reports `login-required` or `unsupported-auth-mode`. A previously valid
login rejected by the running CLI becomes `auth-required`. Cache bytes are never returned,
copied, edited or refreshed by the adapter. `authMode=subscription` records this validated,
forced configuration; the CLI manages expiry/refresh. File-store-only support is deliberate;
keyring and automatic refresh/concurrent refresh remain unverified (OMI-004).

### Parsing, classification and evidence

Known event payloads are validated at the JSONL boundary; unknown typed events are counted and
ignored. `thread.started` becomes a content-free `started`; command/file/MCP/search items
become fixed `tool-use` categories, deduplicated by item ID. The terminal event is guaranteed
even if result construction fails. Event buffering and retained tool/error metadata are bounded.
The final message is read from `-o`, not from intermediate agent messages; this follows the
[official non-interactive output documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

Success requires exit 0, no signal, `turn.completed`, no `error`/`turn.failed`, valid startup,
no malformed stdout, and a valid output file. Completion racing with cancel stays success.
Otherwise classify in order: output overflow; requested cancel; timeout; unsupported model;
unsupported effort; authentication; usage limit; malformed output; other failure. Bare HTTP
429, a mention of an effort flag, and network errors do not by themselves mean quota/settings
failure. Diagnostics use shared redaction, extended for Codex access/refresh/id-token and
API-key assignment names, then collapse whitespace and cap at 500 characters.

Quota error text/codes are synthetic compatibility heuristics. The optional
`rate_limits.updated`/`rateLimits` JSONL extension uses the coordinator PoC snapshot shape;
its event wrapper is **hypothetical**, not live-proven CLI output. At 99% a window is only a
warning. Exhausted secondary windows outrank allowed primary ones, and later allowed events
do not erase rejection. Reset time is absent when not observed; it is never fabricated.

All fixtures under `tests/fixtures/executors/codex/` are labeled **synthetic**, including auth,
limit, unsupported settings and reported-settings examples. Contract tests use a fake executable
and OS-temp profiles, including overlapping profiles on the same adapter. They verify argv,
stdin, unchanged parent environment/cache bytes, output cleanup, cancellation/escalation,
timeout, malformed inputs, replay and bounded progress. SIGINT handlers are installed before
the fake's first stdout byte (PR #85 review). Checks run on the documented Linux/WSL2 baseline;
Windows-native process-group behavior is not claimed.

No live CLI/model calls were made for this amendment. Remaining decisions/evidence: real
error and quota captures; actual model/effort reporting; validating these production defaults
on a subscription; version upgrades; keyring/refresh/concurrency safety; idle timeout;
Windows-to-WSL and tool-subprocess cancellation; explicit handle/event retention policy for
a long-lived runtime. Replay and idempotent collection currently retain completed attempts
for the lifetime of an adapter instance; OMI-015/runtime lifecycle must bound that lifetime or
define an explicit release contract before daemon use.

## Not proven

- **Everything above has not been run against the real CLI** in this task: no live test was run
  (it spends quota). In particular unverified: the `--setting-sources project,local` default on a
  subscription login, the exact text of limit and login errors, the `rate_limit_event` `rejected`
  status name, `result.api_error_status`, and an `effort` field in `init`.
- Cancel of a worker that runs tool subprocesses (no shell tool is exposed yet) and cancel across
  the Windows/WSL boundary (OMI-005).
- A silence (idle) timeout: only a maximum run time exists (tech-stack.md §7 lists both).
- `--max-turns`, used by the PoC, is not passed: it is absent from the installed `--help`.
- Several profiles at once and concurrent token refresh (OMI-004); the contract test only proves
  that two runs get separate per-process profile directories.

## Open decisions

1. **Shell access for Developer workers.** Neither access level can run commands, so a worker
   cannot run `npm run check` itself. Add a level (for example `workspace-write-with-commands`)
   with a deliberate Bash allow-list once the PO decides how much shell a worker gets.
2. **Structured final result.** `finalMessage` is plain text. Validating a `StepResult` from it, and
   using `--json-schema` (Claude) or `--output-schema` (Codex), belongs to the use case that owns
   the result contract.
3. **Effort vocabulary per executor** resolved for OMI-014 by identity mapping (amendment above);
   model-specific availability and effective-setting evidence still need live validation.
4. **`--setting-sources` default** (§3) and **the version range** (§4) are expected to change after
   the first live re-run.
5. Add and run an opt-in live test that goes through `ClaudeCodeExecutor` (the existing live test
   uses the PoC support code, not the adapter) on a real profile before relying on the adapter.
