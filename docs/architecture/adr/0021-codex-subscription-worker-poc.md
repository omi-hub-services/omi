# ADR-0021 — PoC: Codex worker on a subscription login

- Status: Accepted — all three OMI-003 acceptance criteria evidenced by a live run on 2026-11-10 (codex-cli 0.167.0, ChatGPT file auth; read-only, edit, schema error and SIGINT cancel all passed)
- Date: 2026-11-10
- Issue: #4 (OMI-003), epic #1, milestone M0 — Feasibility
- Context: architecture.md §3.5, §7; tech-stack.md §8; ADR-0012; ADR-0013
- Out of scope: production adapter OMI-014; token repair; concurrent profiles/refresh and quota
  failover OMI-004; Windows-to-WSL cancellation OMI-005

## Decision

Mirror the Claude subscription PoC with test-only code under `tests/live/codex-cli/`:

- `codex-cli-process.ts`: explicit environment, argv/stdin, JSONL parsing, timeout, signal
  cancellation, process-group cleanup, classification and diagnostic redaction.
- `codex-worker-result.ts`: one Zod result definition for schema generation and validation,
  plus in-memory auth-mode validation. Parsing errors never include the input.
- `codex-subscription-worker.test.ts`: sequential read, edit, invalid-schema and cancellation
  workflow against an OS-temp Git repository. Stop at the first failed assertion.
- Pure boundary tests live under `tests/unit/live/codex-cli/`. Process tests under
  `tests/integration/live/codex-cli/` use a temporary fake `codex` executable, never a login.
  They verify lifecycle behavior without subscription usage; they do not prove real CLI behavior.

No production layer, dependency, root path or architecture exception is added. The OMI-014
adapter must not import test support. `npm run check` continues to exclude live tests.

## Invocation and isolation

To re-check from the repository root, run this **outside the worker sandbox**:

```sh
OMI_LIVE_CODEX_HOME="$HOME/.codex-profiles/ggtintran" \
  npx vitest run tests/live/codex-cli/codex-subscription-worker.test.ts
```

An unset `OMI_LIVE_CODEX_HOME` skips this suite. An explicitly empty, missing or invalid profile
fails. Use the direct Vitest invocation above: `npm run test:live -- <file>` adds another filter
alongside `tests/live`, so it also selects the Claude suite, which requires its own profile.
Do not alter the Claude suite's guard to accommodate this PoC.

The helper constructs the child environment from a small allowlist and sets `CODEX_HOME` to
this explicit profile. It asserts `OPENAI_API_KEY` and `CODEX_API_KEY` are absent; provider and
parent session overrides are dropped too. Auth validation rejects an API key in the cache,
including a cache that also contains ChatGPT tokens. It keeps only the mode `chatgpt`.

Each invocation uses:

```text
codex exec --ignore-user-config --ignore-rules --ephemeral --json --color never
  -c cli_auth_credentials_store="file" -c forced_login_method="chatgpt"
  -c model_provider="openai" -c approval_policy="never"
  -C <temp-repo> -s <read-only|workspace-write>
  --output-schema <temp-schema> -o <temp-result> -
```

Arguments are an argv array; the prompt is stdin. The CLI default model is used and is not
claimed as a pinned compatibility contract. The flags prevent profile settings/provider
selection and execpolicy files from changing the controlled case; they do not bypass the
sandbox. They are supported by the installed 0.167.0 help output (the forced login setting is
also documented in the auth reference below). User configuration is never edited.

Schemas and final messages are in a separate OS-temp directory, outside the repo being checked.
Both temporary directories are removed even after failure. The source repo is never a worker
workspace, and credentials are never copied into either temporary directory.

## Cases and assertions

| Case | Required evidence |
| --- | --- |
| Auth/version guard | CLI version captured; valid subscription file cache; no API keys in child environment |
| Read-only | Successful turn and zero exit; result validates; codename read from README; no repo changes |
| Edit | Successful turn and zero exit; result validates; exactly `greeting.txt` changes to `Hello, omi` |
| Invalid schema | A single malformed schema argument; nonzero exit and schema diagnostic; classified error |
| Cancel | SIGINT 100 ms after `turn.started`; cancellation recorded; exit within 15 s; no escalation or surviving group |

Disk checks compare HEAD and the two fixture files and inspect Git status including ignored and
untracked files. Result validation rejects extra fields and wrong types. Schema and filesystem
assertions are separate from transport classification. A recorded `success` outcome alone does
not prove an AC: the corresponding `checksPassed` and `structuredResultValid` must also be true.

The initial implementation supplied `--output-schema` twice in the error case; its exit 2 is
**not** evidence of malformed-schema handling. The final harness supplies the option once and
requires a schema-specific diagnostic. The Coordinator verified this corrected case outside the
sandbox in the passing live run described below.

## Auth cache and refresh

The supplied WSL profile has a readable `CODEX_HOME/auth.json` with mode `chatgpt`, access and
refresh tokens, and no API key. Only these validation facts were retained. The Coordinator live
run proved authenticated read and edit execution through this file store for one profile, with
no forbidden auth environment variables in the child. Token refresh and durable persistence of
refreshed credentials remain unverified.

[Official auth documentation](https://learn.chatgpt.com/docs/auth) describes `file` storage under
`CODEX_HOME`, OS `keyring` storage, and automatic token refresh during use. The PoC selects the
file store explicitly. The CLI, rather than framework code, must refresh credentials and persist
the updated cache. A writable profile is therefore needed; `--ephemeral` session operation is
not a promise of zero profile writes. No token is repaired or copied by this harness.

ADR-0012 requires separate WSL `CODEX_HOME` directories per account and no sharing with Windows.
Directory selection isolates the cache location; it does not prove concurrent refresh safety or
independent account quotas. Keyring namespaces, multi-profile concurrency and refresh under
contention remain unverified. Several profiles of one account still share quota.

## JSONL and result shape

[Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes JSONL events including `thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
`item.*` and `error`. Items can carry message text, command output or changes; `turn.completed`
can carry usage. `--output-schema` requests a schema-constrained final response; `-o` saves it.
The final harness generates that schema from Zod and validates the saved result independently.
The Coordinator live event logs confirmed `thread.started`, `turn.started`, `item.started`,
`item.completed` and `turn.completed` in the successful read/edit runs. The cancel log ends after
`turn.started`; the malformed-schema case emitted no JSONL events. Other documented event
shapes, including `turn.failed` and `error`, were not observed in this run.

The parser accepts only JSON objects with a string `type`, ignores empty lines and counts
malformed/untyped lines. Classification requires exit 0, no signal, `turn.completed`, no error
or failed-turn event, no unparsed output, no surviving group, and no timeout/output overflow.
Cancellation is classified separately only if a signal was actually sent and the run did not
succeed. A completion racing cancellation remains success and fails the cancellation case.
Escalation is recorded and fails the real CLI cancellation assertion.

## Process limits and evidence hygiene

- Linux/WSL process groups only. A detached child receives SIGINT first; its group receives
  SIGKILL after 15 s if needed. A 180 s per-invocation hard deadline also kills the group.
- Stdout is capped at 8 MiB and stderr at 64,000 characters. Exceeding stdout bounds fails the
  run. Remaining processes are checked at close and killed; their presence fails the case.
- The helper handles split lines, final lines without a newline, early stdin EPIPE and spawn
  failures. Cancellation cannot be newly scheduled while handling a final line after close.
- `.tmp/live/omi-003-codex-subscription-evidence.json` records versions, auth mode/store,
  child variable **names**, process metadata, fixed diagnostic categories and assertion flags.
- `.tmp/live/omi-003-<case>.events.jsonl` keeps only allowlisted event types; unknown types are
  replaced with `unknown`. No raw stdout, stderr, command, message, session ID or token is saved.
  Diagnostics in memory are scrubbed for keys, bearer values, token fields, JWTs and long tokens.
  Regexes are best effort; the field allowlist is the primary protection for saved logs.
- Evidence is gitignored and written with restrictive creation permissions. Only summary
  findings, rather than raw evidence, are copied into this ADR. A failure remains a failure;
  missing evidence is never interpreted as a pass.

## Initial sandbox attempt on 2026-11-10

One live attempt was made on the initial harness, with this exact command:

```sh
OMI_LIVE_CODEX_HOME="$HOME/.codex-profiles/ggtintran" \
  npm run test:live -- tests/live/codex-cli/codex-subscription-worker.test.ts
```

The initial evidence writer recorded the following observations. The evidence path was later
overwritten by the passing Coordinator run below:

| Observation | Result |
| --- | --- |
| Version / auth guard | `codex-cli 0.167.0`; `chatgpt`; file cache; child had no API key |
| Read-only startup | Exit 1 in 415 ms, no JSONL events; edit was not reached |
| Error case | Exit 2 in 36 ms; duplicate option makes this inconclusive |
| Cancel startup | Exit 1 in 392 ms, no JSONL events; signal trigger never fired |
| Remaining process groups | None observed in these three invocations |
| Combined command | Failed; also selected Claude, whose profile variable was unset |

The installed CLI emitted a read-only-filesystem warning while handling `--version`/`exec --help`
(PATH alias creation). The worker profile is read-only under this sandbox. Actual exec stderr
was not retained by the initial evidence writer, so its exact startup failure cause is
**unverified**; do not claim token refresh or network failure was diagnosed. No sandbox
workaround or second live attempt was made inside the worker sandbox. The revised harness adds
fixed diagnostic categories, corrects error-case argv, and stops after the first failure.

## Coordinator live run on 2026-11-10

The Coordinator ran the corrected harness from revision `ae8fc54` outside the worker sandbox,
using the direct Vitest command in §Invocation and isolation. The command exited 0 with 1/1
tests passing in approximately 24 s. Evidence timestamps span 15:38:06–15:38:29 UTC.

Redacted evidence: `.tmp/live/omi-003-codex-subscription-evidence.json` and
`.tmp/live/omi-003-<case>.events.jsonl` on the machine that ran the test. The summary records
`allChecksPassed: true`, with `checksPassed: true` for every case.

| Case | Observed result |
| --- | --- |
| Environment/auth | `codex-cli 0.167.0`, Node `v24.22.2`, Linux; `authMode: chatgpt`, file store `CODEX_HOME/auth.json`; forbidden auth env list empty |
| Read-only | Success, exit 0, 9,265 ms; structured result valid; repository unchanged |
| Edit | Success, exit 0, 12,971 ms; structured result valid; exactly `greeting.txt` changed to `Hello, omi` |
| Malformed schema | Classified error, exit 1, 73 ms; diagnostic `invalid-schema` |
| Cancel | Classified cancelled, exit 1; SIGINT sent 733 ms after start; exit 65 ms later; no escalation |
| Process/output guards | No surviving process groups, hard timeouts, output overflow or unparsed stdout in any case |

This proves the three OMI-003 acceptance criteria for one subscription profile and this CLI
version: read-only then edit execution without an API key, schema-validated structured results,
and suitability of the saved file cache for those sequential worker runs. It does not establish
that token refresh occurred, nor extend compatibility to other versions or concurrent workers.

## Proven and unverified

| Claim | Evidence / remaining work |
| --- | --- |
| Environment isolation, boundary validation, redaction | Offline unit tests |
| JSONL framing, process exits, cancellation, escalation, deadline and output bounds | Offline integration tests with a fake executable |
| Installed CLI version and subscription file-cache use | **Proven** — Coordinator live run on 2026-11-10; `chatgpt` file auth, no forbidden child auth env |
| Actual subscription read then edit, schema response and graceful Codex cancel | **Proven** — Coordinator live run on 2026-11-10; both structured results valid, disk checks passed, SIGINT exit in 65 ms |
| Successful malformed-schema error handling in real Codex | **Proven** — Coordinator live run on 2026-11-10; exit 1, `invalid-schema`, checks passed |
| Automatic refresh with durable cache, keyring behavior, multi-profile isolation under load | **Unverified**; concurrency/failover belongs to OMI-004 |
| Windows-to-WSL cancellation / tool subprocess cancellation | **Unverified** — this cancel case requests no tools; cross-boundary lifecycle is OMI-005 |

## Open decisions

The passing Coordinator run establishes PoC compatibility for Codex CLI 0.167.0 with one
subscription file-store profile. OMI-014 must decide the production supported version/model
range and settings policy. OMI-004 must prove refresh/concurrency safety before increasing
concurrency above one worker per profile. Production readiness is not established by this PoC.
