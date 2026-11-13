# ADR-0033 — Claude quota from the OAuth usage endpoint

- Status: Accepted
- Date: 2026-11-11
- Issue: #114 (OMI-065)
- Context: ADR-0014 (Coordinator tooling), ADR-0022 (credential boundary), ADR-0031 (quota windows)

## Context

Coordinator quota for Claude came from the newest `rate_limit_event` in the worker logs, so an idle
profile only had old numbers; fresh numbers needed `--probe`, one Haiku call per profile. A spike
on 2026-11-11 (PO approved, Claude Code 2.1.322, both profiles HTTP 200) showed that
`GET https://api.anthropic.com/api/oauth/usage` returns current quota and costs none. Two calls in
a row returned the same utilization.

## Decision

1. **New source `claude-usage-api`** in the WSL collector of `tools/coordinator/quota.ts`. For each
   Claude profile the collector makes one request, with a 10 s timeout and `redirect: "error"`:
   `Authorization: Bearer <claudeAiOauth.accessToken>` and `anthropic-beta: oauth-2025-04-20`. The
   token comes from `~/.claude-profiles/<profile>/.credentials.json`.
2. **Source priority per Claude profile:** `claude-probe` (with `--probe`), then `claude-usage-api`,
   then the last good cached API/probe reading, then `claude-log`. OMI-068 stores validated,
   redacted readings per profile in WSL `~/omi-runs/.quota-cache.json`; cache reads retain the
   original source and observation time. API calls are spaced by `QUOTA_MIN_INTERVAL_MS`
   (five minutes), shared across status, terminal/web watch and pick-profile collectors.
   HTTP 429 records the next allowed call from `Retry-After` (delta seconds or HTTP date),
   with the same five-minute minimum/default. Calls are skipped until then, even without a
   cached reading. Per-profile reservation locks prevent simultaneous calls; atomic writes
   with a short cache-write lock preserve other profiles. A failed cache reservation skips
   the endpoint. Stale locks expire after 30 seconds (the fetch timeout is 10 seconds).
   `--probe` still runs during backoff and updates the cache without clearing backoff;
   cached model windows are retained because probe events do not report them.
3. **Parsing is pure** (`parseClaudeUsage`): `five_hour` and `seven_day` (`utilization` 0–100,
   `resets_at` ISO) become `QuotaWindow`s; `limits[]` entries of kind `weekly_scoped` with a model
   display name become `ModelWindow`s (`model`, `usedPercent`, `resetsAt`). `session` and
   `weekly_all` entries are ignored, as they repeat the two windows. `observedAt` is the collector
   clock at the call. A reading with a full window is `limited`.
4. **Fallback to the last good cache, then `claude-log`** on an expired token (`expiresAt`), a missing credential file, any
   HTTP error, a timeout, a network error, a body that is not a JSON object, or a shape the parser
   rejects (neither window readable, non-numeric utilization). The reason is kept in
   `ProfileQuota.note` (`usage api: HTTP 401`) and shown in `status.ts` next to the log reading.
5. **Per-model windows** are display only: `status.ts` shows `weekly Fable 99%`, `watch.ts` appends
   `Fable 99%`. `pickProfile` keeps its score. Only with a worker model (`pick-profile --model
   NAME`, case-insensitive exact match on the display name) does a window below
   `minSevenDayLeftPercent` refuse the profile, with `reason: <Model> weekly N% left < M%`.
   Since OMI-068, pick-profile infers complexity/model before quota filtering and checks the
   selected Claude model automatically when `--model` is omitted. Invocation is unchanged.

## Risk: undocumented API

The endpoint is not a documented API. Fields may be renamed, the beta header may change or the
endpoint may be switched off. The mitigation is the fallback in 4: the parser throws on an unknown
shape and the Coordinator keeps working on log readings, with the reason visible. The collector
forwards only the whitelisted fields, so new or unknown keys never reach the host. Nothing in
`src/` uses the endpoint (out of scope); this is Coordinator dev tooling and OMI-004 runtime
detection replaces it.

## Token handling (ADR-0022)

- The token is read only inside the node collector process in WSL and sent only to
  `api.anthropic.com`. Redirects are not followed, so it cannot be forwarded elsewhere.
- It never enters stdout, stderr, an error message, a fixture, a test snapshot or evidence. A
  failure carries only `HTTP <status>` or an error kind (`token expired`, `timeout`,
  `network error`, `response is not JSON`, `unexpected response shape`, `no readable credentials`).
  The underlying exception message is dropped, because it could echo request details.
- The collector emits only `five_hour`, `seven_day` and `limits` reduced to
  `kind, percent, resets_at, model`. Account ids, emails and other keys of the response are dropped
  before the host sees them.
- Tests use a fake token and a stubbed `fetch`; `npm run check` needs no real credential and makes
  no network call.

## Why the token is not refreshed

A refresh rotates the refresh token and writes `.credentials.json`. That is a write into a profile
directory, which the Coordinator tooling must not do, and a failed or racing write could log a
worker out. An expired token is expected for an idle profile; the cache/log fallback keeps tooling
available. The refresh-token grant is never called, by tooling or by the framework adapter.

## Expired token: report it, probe once (OMI-094, 2026-11-13)

On 2026-11-13 the `ggtintran` profile showed 9-hour-old data. The token had expired, because it
renews only when `claude` runs on the profile (about every 8 hours), and the cached reading was
shown with no reason. Rules:

1. **Report.** An expired token is reported on every read, also inside the five-minute call
   spacing: the collector emits `{kind: "expired", profile, expiresAt}` before the spacing check.
   `ProfileQuota.tokenExpiresAt` carries it. `status.ts`, the terminal and web watch and
   `pick-profile` show `token expired` with the data age (`token expired, data 9h old`). Other
   collector errors (`HTTP n`, `network error`, `timeout`, `no access token`, ...) are shown the
   same way, as the row note, and no longer only in `status.ts`.
2. **Probe once.** The pure rule `decideExpiryProbe` (`src/domain/profiles/quota-policy.ts`) says
   whether to run the existing `--probe` path (one Haiku call, which makes the CLI renew its own
   token, and writes nothing that `claude` does not write itself). A probe runs only when the token
   has expired, no probe of the profile ran inside the cooldown (one hour,
   `EXPIRY_PROBE_COOLDOWN_MS`), and none was run for this same `expiresAt`. A probe that fails or
   leaves the token expired is therefore not repeated until a new expiry exists. Usage is read
   again after the probe.
3. **Who probes.** The watch poller does, automatically: after a poll that reports an expired
   token it runs the collector once more in `expired` mode for those profiles only. `status.ts` and
   `pick-profile` only report; `pick-profile --probe` still probes everything. State is in
   `~/omi-runs/.quota-cache.json` (`probeAt` after any probe, `probedForExpiresAt` for an expiry
   probe), under the per-profile lock, so watch, status and pick-profile share the cooldown. The
   rule is recorded before the probe runs, so a crash does not loop either.
4. **One rule.** The collector embeds the framework function's source and the poller imports it;
   `src/infrastructure/executors/claude-code/claude-code-quota.ts` calls it too when its optional
   `probe` is configured, with the state in memory per process.

## Consequences

- `status.ts`, `watch.ts` and `pick-profile` show fresh Claude numbers without a probe.
- Idle profiles with an expired token fall back to the last good cache, then logs, with `token
  expired` and the data age shown. The watch renews such a token with one probe per expiry.
- A worker resume writes its follow-up to `omi-NNN-resume-<step>-<attempt>.md` (ADR-0014, OMI-111),
  so `omi-NNN-prompt-<step>-<attempt>.md` keeps the thread's full packet and the watch shows that packet's skills and rules, not the findings packet's.
- Model windows are visible, which closes ADR-0031 decision 4's "invisible until rejected" for
  Claude; whether the product scheduler uses them is left to OMI-018.

## Framework port (OMI-078, 2026-11-12)

The framework now reads this endpoint itself, so the sentence above that nothing in `src/` uses it
no longer holds. `src/infrastructure/executors/claude-code/claude-code-quota.ts` ports decisions 1,
3 and 4 and the token rules (in memory, never stored, printed or refreshed; redirects are errors).
The `QuotaReader` port, the Codex `app-server` reader and the pure policy
(`src/domain/profiles/quota-policy.ts`) sit beside it. Differences from the Coordinator tooling:
the fallback is the last good reading kept in memory per process (no `.quota-cache.json`, no
worker-log fallback); a profile with no reading at all stays usable and ranks last, where
`pick-profile` refuses it without `--probe`; selection is gated by an optional `quota` block in
`project.yaml`, and a Coordinator-shared profile is listed there and penalised or forbidden. The
mid-run limit failover (`failover-step.ts`) is unchanged and does not read quota.

## Token investigation (OMI-068, 2026-11-11)

Read-only inspection found both the WSL `ggtintran` credential and the readable Windows default
credential unexpired. The local account UUIDs match (identities themselves were not emitted).
Access and refresh tokens differ, which is compatible with separate login sessions and does not
establish staleness. The WSL expiry was about five minutes later than the
Windows expiry. No credentials were changed or refreshed, and no live endpoint request was made
for this investigation. Thus expiry and account mismatch are ruled out for the inspected profiles at inspection time;
usage-endpoint acceptance of each token and the historical cause of HTTP 429 remain unverified. The reported successful
probe uses the CLI/model path, so it does not prove that the usage endpoint accepts the same token.
