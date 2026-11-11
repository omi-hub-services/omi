# Claude Code adapter fixtures

Secret-free output fixtures for `tests/contract/executors/claude-code/`. Every id, path, model
and e-mail here is made up (`00000000-…` ids, `example.invalid`). Do not paste real CLI output.

| Fixture                                          | Provenance                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `success.stream.jsonl`                           | Event sequence and result fields of the OMI-002 live run (ADR-0013): hooks, init, tool use, result.            |
| `cancelled.stream.jsonl`                         | OMI-002: SIGINT gives exit 0 with `error_during_execution` and `is_error: true`.                               |
| `unsupported-model.*`                            | OMI-002: unknown model gives subtype `success` with `is_error: true`, exit 1, stderr tag `unrecognized_model`. |
| `usage-limit*.stream.jsonl`                      | **Synthetic.** No real limit was captured; wording follows the CLI's documented messages.                      |
| `rate-limit-allowed-recorded.jsonl`              | **Recorded** (OMI-004, ADR-0031): one `rate_limit_event` of a live Haiku run, Claude Code 2.1.322; ids zeroed. |
| `auth-failure.stream.jsonl`                      | **Synthetic.** Same caveat.                                                                                    |
| `auth-not-logged-in.stderr.txt`                  | **Synthetic.** Same caveat.                                                                                    |
| `unsupported-effort.stderr.txt`                  | **Synthetic.** Option-parser wording; not captured.                                                            |
| `success-effort-reported.*`                      | **Hypothetical.** OMI-002 did not show an `effort` field in `init`; this exercises the optional read.          |
| `malformed.*`, `truncated.*`, `invalid-result.*` | Hand-made faults: garbage and truncated lines, a missing terminal event, a result without required fields.     |
| `auth-status-*.json`                             | Shape of `claude auth status --json` from ADR-0013 (field list) with fake values.                              |

Synthetic fixtures prove the classifier, not the real CLI. Replace them with captured output
(after redaction) when the live test is re-run on a new Claude Code version.
