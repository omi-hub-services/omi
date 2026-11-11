# ADR-0031 — PoC: profile isolation, quota windows and continuation after a profile switch

- Status: Accepted for Claude Code (two profiles, isolation and checkpoint continuation evidenced
  by live runs on 2026-11-11). **Codex profile-to-profile failover is not proven** (one Codex
  profile exists); see "Product blocker".
- Date: 2026-11-11
- Issue: #5 (OMI-004), epic #1, milestone M0 — Feasibility. Scope as updated by the PO on
  2026-11-11: Claude profiles `ggtintran` and `minibox`, Codex profile `ggtintran`.
- Context: architecture.md §7 (profile registry, failover), §10 (checkpoint); ADR-0005
  (tool-independent checkpoint); ADR-0013 and ADR-0021 (single-profile PoCs); ADR-0022; ADR-0023
  (AgentExecutor port, both adapters); ADR-0028; ADR-0030
- Consumed by: the profile registry/probe (`src/infrastructure/profiles/`), selection and
  `failover-step` use cases (`src/application/use-cases/profiles/`), checkpoint/recovery (OMI-016)

## Context

architecture.md §7 makes isolation of several subscription profiles a mandatory PoC: headless
support alone does not show that two logins stay apart, that they can run at the same time, that
a quota limit can be told apart from other failures, or that work can continue on another
profile. ADR-0013 and ADR-0021 each proved one profile. ADR-0023 left "several profiles at once",
"concurrent token refresh" and a live run of the production adapter open.

## Decision

1. **A profile is a directory, chosen per process.** Claude Code: `CLAUDE_CONFIG_DIR`; Codex:
   `CODEX_HOME`. The adapters already build the whole child environment from an allowlist and set
   only this variable (ADR-0023). Nothing switches a global login, so runs on different profiles
   overlap safely. The evidence below confirms this for Claude Code 2.1.322 and Codex 0.167.0 on
   Linux/WSL2: credentials live in the directory (`.credentials.json`, `auth.json`), not in a
   store shared across profiles.
2. **Account group = account, not directory.** The two Claude profiles are different accounts
   (compared in memory from `claude auth status`, never recorded) and report different quota
   windows. Two directories of one account would share one quota and must cool down together; the
   PoC orchestration does this by `accountGroup`.
3. **Continuation is from a checkpoint, never from a transcript.** A session persisted on one
   profile cannot be resumed on another (`No conversation found with session ID`), which confirms
   ADR-0005: after a switch, the new attempt starts from a filesystem checkpoint (git head, diff,
   file hashes, next action) stored in the hash-pinned `ArtifactStore`, verified against the
   workspace before the domain gate lets the new attempt start.
4. **Quota is read only from what the CLI reports.** Claude Code's `rate_limit_event` gives the
   binding window and every window in `unifiedWindows`. No per-model window (such as a weekly
   Fable window) is readable from the logs; since OMI-065 the OAuth usage endpoint reports one
   (ADR-0033), which only the Coordinator tooling reads. Selection must therefore treat a model-specific limit
   as invisible until a run is rejected, and cool down on the rejection.
5. **Simulated limits are labelled and separate from real quota detection.** The failover path
   records the limit `source`: `cli-reported` (the adapter classified the CLI's own output as
   `usage-limit`) or `injected` (the harness declared a limit after a successful attempt). An
   injected limit never changes the adapter's outcome and spends no quota.

## What was built (tests only; no production code, dependency or structure change)

| Path | Layer | Purpose |
| --- | --- | --- |
| `tests/live/multi-profile/rate-limit-windows.ts` | live support | Zod parse of every `rate_limit_event` window; per-model window detection |
| `tests/live/multi-profile/claude-profile-namespace.ts` | live support | Credential-file metadata, `auth status` facts, transcript lookup; no content read |
| `tests/live/multi-profile/profile-failover.ts` | live support | Orchestration over the real port, domain machines, retry policy and artifact store |
| `tests/live/multi-profile/continuation-task.ts` | live support | Two-part edit whose state the harness checks on disk |
| `tests/live/multi-profile/claude-profile-isolation.test.ts` | live (opt-in) | Namespace, concurrency, per-profile quota, session namespace |
| `tests/live/multi-profile/claude-profile-continuation.test.ts` | live (opt-in) | A → B continuation through `ClaudeCodeExecutor` |
| `tests/live/multi-profile/codex-profile-isolation.test.ts` | live (opt-in) | `CODEX_HOME` vs `~/.codex`; two concurrent workers on one profile |
| `tests/integration/live/multi-profile/profile-failover.test.ts` | integration (in `check`) | Fault injection with a fake `claude` per profile, real adapter and SQLite store |
| `tests/unit/live/multi-profile/rate-limit-windows.test.ts` | unit (in `check`) | Window parsing, rejection, drift |
| `tests/fixtures/executors/claude-code/rate-limit-allowed-recorded.jsonl` | fixture | One recorded `rate_limit_event`, ids zeroed |

`profile-failover.ts` is evidence for the future `failover-step` use case, not a replacement for
it: the production use case must persist attempts, profile observations and checkpoints in
SQLite through the runtime (architecture.md §8), which this PoC does not.

Run (outside CI; each suite is skipped when its variables are unset):

```sh
OMI_LIVE_CLAUDE_PROFILE_A=$HOME/.claude-profiles/minibox \
OMI_LIVE_CLAUDE_PROFILE_B=$HOME/.claude-profiles/ggtintran \
  npx vitest run tests/live/multi-profile/claude-profile-isolation.test.ts
# same variables: tests/live/multi-profile/claude-profile-continuation.test.ts
OMI_LIVE_CODEX_HOME=$HOME/.codex-profiles/ggtintran \
  npx vitest run tests/live/multi-profile/codex-profile-isolation.test.ts
```

`OMI_LIVE_CLAUDE_MODEL` defaults to `claude-haiku-5-5`; a Fable model is refused (PO decision).
`OMI_LIVE_CODEX_MODEL` defaults to `gpt-6-luna`. `OMI_LIVE_INJECT_LIMIT=0` makes the continuation
suite require a real limit. Evidence goes to the gitignored `.tmp/live/omi-004-*.json(l)`.

## Evidence

Live runs by the OMI-004 worker on 2026-11-11 (06:38–06:39 UTC), branch
`task/omi-004-multi-profile-poc`, Claude Code 2.1.322, Codex 0.167.0, Node v24.22.2, WSL2. A =
`minibox`, B = `ggtintran`. All suites passed: isolation 3/3, continuation 1/1, Codex 2/2.

### Runs and quota windows

| # | Suite / case | Profile | Model | Result | Windows in `rate_limit_event` (utilization) |
| --- | --- | --- | --- | --- | --- |
| 0 | exploration capture (raw stream) | minibox | haiku-5-5 | success, 1 turn | `five_hour` 0.10, `seven_day` 0.68; overage `rejected` (`org_level_disabled`) |
| 1 | concurrent | minibox | haiku-5-5 | success, 1 turn, 0.5–3.0 s | `five_hour` 0.28, `seven_day` 0.69 |
| 2 | concurrent | ggtintran | haiku-5-5 | success, 1 turn, 0.5–2.7 s | `five_hour` 0.03, `seven_day` 0.45 |
| 3 | persisted session | minibox | haiku-5-5 | success, 1 turn | `five_hour` 0.28, `seven_day` 0.69 |
| 4 | resume #3 on B | ggtintran | haiku-5-5 | refused before a model call (exit 1, 0 turns, 0 assistant events) | none |
| 5 | continuation attempt 1 | minibox | haiku-5-5 | succeeded, 3 turns, Read+Edit | adapter signal: `allowed`, `five_hour` |
| 6 | continuation attempt 2 | ggtintran | haiku-5-5 | succeeded, 3 turns, Read+Edit | adapter signal: `allowed`, `five_hour` |
| 7 | Codex concurrent 1 | codex ggtintran | gpt-6-luna, low | succeeded, 1 turn, 8.2 s | no rate-limit event in `exec --json` |
| 8 | Codex concurrent 2 | codex ggtintran | gpt-6-luna, low | succeeded, 1 turn, 8.0 s | no rate-limit event in `exec --json` |
| C | Coordinator run (prior evidence) | minibox, ~3 % 5 h left; UI "weekly Fable 100 %" | `claude-fable-5-1` | 5 turns, then `rejected`, `five_hour` utilization 1.01 | `five_hour`, `seven_day`, `seven_day_overage_included`; **no Fable key** |

Row C is the Coordinator's observation, given to this task, not reproduced here (no Fable runs, PO
decision). `ggtintran` (the Coordinator's account) spent 1 + 3 Haiku turns; run 4 spent none. Per
run, each profile reported its own reset times and utilization, so the windows are per account.
No observation in rows 0–6 or C contained a window outside `five_hour`, `seven_day` and
`seven_day_overage_included`.

### Isolation facts (no model call)

| Claim | Observation |
| --- | --- |
| Separate config directories, both separate from `~/.claude` | distinct realpaths; default not equal to either |
| Separate credential files | `.credentials.json` present in each, mode 600, not a symlink, different inodes |
| Login comes from the directory | A and B: `loggedIn`, `claude.ai`, `firstParty`, `pro`; `~/.claude` and an empty temp dir: `loggedIn: false` |
| Different accounts | account digests differ (compared in memory, never written) |
| Session namespace | transcript of #3 only under A's `projects/`; resume on B: `No conversation found with session ID` |
| Codex `CODEX_HOME` vs `~/.codex` | profile: `Logged in using ChatGPT`; `~/.codex` and an empty temp `CODEX_HOME`: `Not logged in`; `~/.codex` has no `auth.json` and stayed unchanged |
| Codex concurrent workers on one profile | both succeeded, 8.0 s overlap, distinct thread ids; cache still a valid `chatgpt` file cache; `login status` still logged in |
| Codex token refresh | **not exercised**: `auth.json` unchanged, `last_refresh` stayed at 2026-11-10T06:42Z (about 24 h old) |

### Continuation A → B (run 5–6)

`ClaudeCodeExecutor` (production adapter, ADR-0023 open decision 5) ran both attempts with its
default flags; this is also the first live run of `--setting-sources project,local` and
`--effort low` on a subscription login. Trace:

1. Probe both profiles (no quota): `ready`, 2.1.322 → profile `unknown → ready`.
2. Step `pending → ready → running`; attempt 1 on A edits part 1; `succeeded`.
3. **Injected** limit (source `injected`; A was not limited). Retry policy → `failover`, cooldown
   = bounded backoff (no reset time known).
4. Step `running → waiting_resource` (writer stopped: the process had exited).
5. Checkpoint: diff and manifest written to the SQLite-backed artifact store.
6. Profile A `ready → cooldown`; availability: A `COOLDOWN_ACTIVE`, B allowed.
7. Manifest read back hash-pinned and compared with the workspace: verified. Step
   `waiting_resource → ready → running` (the domain `start` gate needs the verified context).
8. Attempt 2 on B, prompt built only from the checkpoint; `succeeded`. A late `fail` of attempt 1
   is refused (`STALE_ATTEMPT`). Step `running → succeeded`.
9. On disk: both parts done, only `M parts.txt`.

### Fault injection without quota (in `npm run check`)

`tests/integration/live/multi-profile/profile-failover.test.ts` runs the real adapter against one
fake `claude` whose behaviour is chosen by `CLAUDE_CONFIG_DIR`:

| Case | Limit source | Result |
| --- | --- | --- |
| A replays the `usage-limit` fixture (rejected event + 429) | `cli-reported` (synthetic fixture) | cooldown until the reported reset; B continues; disk correct; B's stdin has the checkpoint, not A's prompt |
| A succeeds, limit declared | `injected` | adapter outcome stays `succeeded`; cooldown = backoff; B continues |
| A and B in one account group | `cli-reported` | both cool down; `waiting_resource`; B never started |
| B logged out | `cli-reported` | B `LOGIN_REQUIRED`; `waiting_resource` |
| A login failure (401 fixture), injection requested | none | `stop` `LOGIN_REQUIRED`; not treated as a limit; B never started |
| Workspace changed after the checkpoint | `cli-reported` | verification fails; `start` refused `CONTEXT_NOT_SAVED`; B never started |
| A completes everything | none | no failover; B never started |

### Separation of simulated and real limits (AC-3)

| Source | Where | Counts as real quota detection? |
| --- | --- | --- |
| `injected` | live continuation, integration test | **No.** Harness decision after a successful attempt; adapter outcome unchanged |
| `cli-reported` from a fixture | integration test (fake CLI) | **No.** Proves the classification path only; the fixture is synthetic |
| `cli-reported` on a live run | live continuation with a really limited profile | Yes; not observed in this task |
| `rate_limit_event` with `rejected` | Coordinator run C | Yes (the real status name and window keys); observed outside these suites |

## Proven / not proven

| Claim | Status |
| --- | --- |
| Two Claude profiles: separate config, credential and login namespace | **Proven** (live, no quota) |
| Two Claude profiles running at the same time | **Proven** (live, 2.2 s overlap) |
| `rate_limit_event` per profile, windows and utilization recorded | **Proven** (live, both profiles) |
| Per-model (e.g. weekly Fable) window readable from the logs | **Not available**: no such key in any observation, including the Fable rejection (run C) |
| Session/transcript namespace per profile; no cross-profile resume | **Proven** (live) |
| Checkpoint continuation A → B through the production Claude adapter | **Proven** (live, injected limit) |
| Automatic failover triggered by a **real** Claude limit, end to end | **Not proven live.** Classification of a CLI-reported limit is proven with a synthetic fixture; the real `rejected` status name and keys come from run C, where the adapter was not in the loop |
| Codex profile separate from `~/.codex` | **Proven** (live, no quota) |
| Two Codex workers on one profile at the same time | **Proven** (live) |
| Codex token refresh under concurrent processes | **Not proven**: no refresh happened (`last_refresh` unchanged); the CLI keeps `auth.json.lock` / `auth.lock` files in the profile, which suggests a lock, but that was not exercised |
| Codex quota windows | **Not observable** via `codex exec --json` 0.167.0 (no rate-limit event in runs 7–8) |
| Codex profile-to-profile failover | **Not proven**: only one Codex profile exists; no auth file was copied or moved to fake a second one |
| Concurrency above one worker per Claude profile | Not tested; keep the default of one worker per profile (architecture.md §7) |
| Windows-native behaviour, other CLI versions | Not tested |

## Product blocker (AC-5)

- **Claude Code:** automatic failover between profiles is achievable. Isolation, concurrency,
  limit classification, cooldown, selection and checkpoint continuation work without a human
  step. What is missing is product code (`failover-step` with persisted state) and one live run
  with a really limited profile. Neither needs a PO decision.
- **Codex:** automatic failover between Codex profiles **cannot be shown and is a product
  blocker** while only one Codex profile exists. With one profile, a Codex limit can only lead to
  `waiting_resource`, or to another tool if the step's capability allows it (OMI-015 selection).
  Codex quota is also not visible in `exec --json`, so the only signal is the run's own failure.
  OMI-004 must not be closed as Done with a manual workaround for this; the PO decides (see Open
  decisions).

## Consequences

- The profile registry stores `profileHome` and an account group per profile. It never stores a
  token. One worker per profile stays the default.
- Probing (`--version`, `auth status`, `login status`) costs no quota and is enough to mark a
  profile `ready` or `login-required`.
- The scheduler cannot plan around per-model weekly limits: it only learns about one from a
  `rejected` event. The cooldown uses the reported `resetsAt` when present, otherwise the bounded
  backoff of `retry-policy.ts`.
- The checkpoint is the only thing carried across profiles. The continuation prompt is built from
  it. Transcripts and session ids stay with their profile.
- The production adapter defaults (`--setting-sources project,local`, explicit `--effort`) now
  have one live confirmation on Claude Code 2.1.322 (ADR-0023).

## Open decisions (PO)

1. **Codex failover:** provide a second Codex account/profile, accept cross-tool failover to
   Claude for Codex steps, or accept `waiting_resource` for Codex steps. Until then, Codex
   profile-to-profile failover stays not proven.
2. **Real-limit live run:** whether to spend a deliberately exhausted profile on one end-to-end
   run with `OMI_LIVE_INJECT_LIMIT=0`, or to accept the fixture-based classification plus run C.
3. **Per-model limits:** accept that a per-model weekly limit is visible only as a rejection (no
   pre-emptive avoidance), or require a different quota source.
