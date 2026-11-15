# Codex executor fixtures

All files here are **synthetic**, secret-free fixtures. None is a recorded CLI transcript or
a real credential cache. `synthetic-*` values are deliberately inert. The contract tests run
only an executable stand-in, never the installed Codex CLI or a model.

- `success.stream.jsonl` follows the documented JSONL shapes and ADR-0021's observed event
  names. Command and agent-message contents prove that neutral events never forward payloads.
  The fake writes a different final message to `-o`, which is the authoritative result source.
- `usage-limit.stream.jsonl` synthesizes a rejected secondary window from the shape in
  `tests/fixtures/coordinator/codex-rate-limits.json`. The PoC snapshot itself reports 99%,
  which is a warning, not exhaustion. `rate_limits.updated` and its `rateLimits` wrapper are a
  **hypothetical JSONL extension**, not a claim that CLI 0.167.0 emits quota snapshots. Without
  such a snapshot, a textual/code limit error has no invented reset time.
- `auth-failure.stream.jsonl`, `unsupported-model.stream.jsonl` and
  `unsupported-effort.stderr.txt` test error classification. Exact wording/codes require live
  captures. The unsupported-effort fixture uses `max` as an example rejection; availability
  depends on the selected model and CLI. No effort is silently reduced.
- `malformed.stream.jsonl` includes a non-JSON line after startup. Other invalid shapes,
  missing completion, unknown events and truncated JSON are constructed in the tests.
- `cancelled.stream.jsonl` follows the failed-turn envelope. The fake installs its SIGINT
  handler before emitting startup, then exits 1 after replaying it. Actual live SIGINT evidence
  is in ADR-0021; this fixture is not that capture.
- `success-reported-settings.stream.jsonl` adds **hypothetical** optional `model` and
  `model_reasoning_effort` fields to `thread.started`. The PoC did not establish these fields;
  ordinary streams omit `actual` in the neutral result rather than copying the request there.
- `subscription-cache.json`, `api-key-cache.json`, `mixed-cache.json` exercise in-memory auth
  validation. Tests write them only to OS-temp profiles and verify that adapter operations do
  not change them. They never read a user's profile.

Version target: **codex-cli 0.167.0**, the ADR-0021 live-tested version. Production support is
deliberately `>=0.167.0 <0.167.1` until a newer version is captured and reviewed. These tests
provide offline boundary/lifecycle evidence, not live subscription/model compatibility.
