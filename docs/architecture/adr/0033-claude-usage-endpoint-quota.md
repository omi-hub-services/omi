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
   then `claude-log`. The usage call is made on every read, also with `--probe`; the probe wins.
3. **Parsing is pure** (`parseClaudeUsage`): `five_hour` and `seven_day` (`utilization` 0–100,
   `resets_at` ISO) become `QuotaWindow`s; `limits[]` entries of kind `weekly_scoped` with a model
   display name become `ModelWindow`s (`model`, `usedPercent`, `resetsAt`). `session` and
   `weekly_all` entries are ignored, as they repeat the two windows. `observedAt` is the collector
   clock at the call. A reading with a full window is `limited`.
4. **Fallback to `claude-log`** on an expired token (`expiresAt`), a missing credential file, any
   HTTP error, a timeout, a network error, a body that is not a JSON object, or a shape the parser
   rejects (neither window readable, non-numeric utilization). The reason is kept in
   `ProfileQuota.note` (`usage api: HTTP 401`) and shown in `status.ts` next to the log reading.
5. **Per-model windows** are display only: `status.ts` shows `weekly Fable 99%`, `watch.ts` appends
   `Fable 99%`. `pickProfile` keeps its score. Only with a worker model (`pick-profile --model
   NAME`, case-insensitive exact match on the display name) does a window below
   `minSevenDayLeftPercent` refuse the profile, with `reason: <Model> weekly N% left < M%`. Without
   `--model` nothing changes, because the model is chosen after the profile (OMI-058).

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
worker out. An expired token is expected for an idle profile; the log fallback is enough.

## Consequences

- `status.ts`, `watch.ts` and `pick-profile` show fresh Claude numbers without a probe.
- Idle profiles with an expired token fall back to the log reading until the profile runs again.
- Model windows are visible, which closes ADR-0031 decision 4's "invisible until rejected" for
  Claude; whether the product scheduler uses them is left to OMI-018.
