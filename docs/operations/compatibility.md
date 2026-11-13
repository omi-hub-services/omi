# Compatibility

Operational use of the CLI (commands, failures, folder rules) is in [handbook.md](handbook.md).

Versions listed here are only what has actually been checked; nothing else is promised
(tech-stack.md §3). Status values: `supported` (checked with evidence), `untested`,
`unsupported`. A version not listed is `untested`.

## Worker environment (WSL2)

Checked 2026-11-10 by the OMI-002 live runs (Coordinator, profile `~/.claude-profiles/b`): first
on commit `f141f34`, then re-run with the tightened assertions on `b0ab3b3` (merged head of
PR #60), 5/5 passed both times. Evidence: ADR-0013 §Evidence, the PR #60 body and its
independent review comment; raw redacted files in `.tmp/live/omi-002-*` on the machine that ran
it (gitignored).

| Component   | Version                                                                  | Status    | Checked    | Evidence / scope                                                                 |
| ----------- | ------------------------------------------------------------------------ | --------- | ---------- | -------------------------------------------------------------------------------- |
| OS          | Ubuntu 24.04.5 LTS on WSL2 (kernel 5.15.167.4-microsoft-standard-WSL2)    | supported | 2026-11-10 | Worker + `npm run check` + OMI-002 live run. WSL2 lifecycle across the Windows boundary is OMI-005 |
| Node.js     | 24.22.2                                                                  | supported | 2026-11-10 | `.nvmrc`; `npm run check` and OMI-002 live run                                   |
| Git         | 2.43.0                                                                   | supported | 2026-11-10 | Temp repo init/commit/status in the OMI-002 live run; worktree flows untested    |
| gh          | 2.103.3 (2026-10-26)                                                     | untested  | 2026-11-10 | Version recorded only; no gh operation exercised by OMI-002                      |
| Claude Code | 2.1.322                                                                  | supported | 2026-11-10 | `claude -p` worker: read, edit, error, SIGINT cancel (ADR-0013). Single profile, two runs |
| Codex CLI   | 0.167.0                                                                  | supported (PoC) | 2026-11-10 | Coordinator live run: subscription read, edit, schema error and SIGINT cancel (ADR-0021) |

## Claude Code auth mode

| Mode                                                                 | Status      | Notes                                                                                                   |
| -------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| Subscription login (`authMethod: claude.ai`, `apiProvider: firstParty`, plan `pro`) via a `CLAUDE_CONFIG_DIR` profile, `claude -p` | supported   | One profile, sequential runs; `init.apiKeySource: none` in every run (ADR-0013)                        |
| `--bare` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` | unsupported | Excluded by design (tech-stack.md §8); the live test strips them from the child env                    |
| Two Claude profiles in parallel / checkpoint continuation | supported (PoC) | ADR-0031, live 2026-11-11; continuation used an injected limit; concurrent token refresh not established |
| Quota/rate-limit detection | partially checked | ADR-0031: real window events; fixture classification and injected continuation do not prove real-limit end-to-end failover |

Note: the default model is a per-profile property (profile `b`: `claude-sonnet-5-5`; another
profile on the same machine: `claude-opus-5-5`). Do not infer it from the Claude Code version.

## Codex CLI subscription worker

OMI-003 proves a subscription worker using Codex CLI **0.167.0**, Node **v24.22.2**, Linux,
and one WSL file-store profile. The Coordinator ran revision `ae8fc54` outside the worker
sandbox on 2026-11-10: exit 0, 1/1 tests passed in approximately 24 s. Read-only and edit
results validated against the output schema and passed disk checks; malformed schema and
SIGINT cancellation were classified correctly. Auth mode was `chatgpt`, with no forbidden auth
environment variables in the child. See [ADR-0021](../architecture/adr/0021-codex-subscription-worker-poc.md)
for evidence and the earlier sandbox startup failures. Refresh, keyring behavior, concurrent
profiles and Windows-to-WSL cancellation remain unverified.

| Mode / capability | Status | Notes |
| --- | --- | --- |
| ChatGPT subscription, file store under explicit WSL `CODEX_HOME` | supported (PoC, live 2026-11-10) | Authenticated read/edit proven for one profile; durable refresh remains unverified |
| Read-only then edit with schema output | supported (PoC, live 2026-11-10) | Exit 0 for both; structured results valid; read-only repo unchanged and edit changed only `greeting.txt` |
| Real CLI schema error / SIGINT cancel | supported (PoC, live 2026-11-10) | Invalid schema: exit 1, `invalid-schema`; cancel: exit 65 ms after SIGINT, no escalation or surviving group |
| API key (`OPENAI_API_KEY`, `CODEX_API_KEY`, cached API key) | unsupported | Excluded by design and guarded in tests |
| OS keyring, concurrent profiles/refresh, quota failover | untested | OMI-004; separate cache directories do not imply separate quotas |

Coordinator command (outside the worker sandbox, from this repo):

```sh
OMI_LIVE_CODEX_HOME="$HOME/.codex-profiles/ggtintran" \
  npx vitest run tests/live/codex-cli/codex-subscription-worker.test.ts
```

Read `.tmp/live/omi-003-codex-subscription-evidence.json` and `omi-003-*.events.jsonl` on the
machine running the test. The 2026-11-10 run recorded `allChecksPassed: true` and every per-case
check passed. Require these checks again when re-checking support. This command selects Codex
alone. `npm run test:live -- <file>` also selects the Claude suite and requires its profile variable. Without `OMI_LIVE_CODEX_HOME`, the Codex suite skips;
with an invalid or empty value it fails. Live tests remain outside `npm run check` and CI.

The production Codex adapter targets **`>=0.167.0 <0.167.1`**, with the same subscription
file-store namespace and controlled settings as ADR-0021, plus explicit model/effort. Offline
contract tests exercise the neutral port with synthetic fixtures and a fake executable; they
do not extend the live evidence above. No real CLI/model calls were made for OMI-014.
Effective model/effort fields and quota-event wrappers remain hypothetical; missing effective
settings and reset times are left absent. See the [ADR-0023 OMI-014 amendment](../architecture/adr/0023-agent-executor-port-and-claude-adapter.md#omi-014-amendment-production-codex-adapter-2026-11-11-issue-17)
for the effort mapping, probe gate and remaining live-validation decisions.

## Doctor worker CLI classification (OMI-107)

`doctor` classifies `claude --version` and `codex --version` against the adapters' ranges. The
ranges exist once in code (`SUPPORTED_CLAUDE_CODE_RANGE`, `SUPPORTED_CODEX_RANGE`); this table
mirrors them.

| CLI | Supported range | `untested` | `unsupported` |
| --- | --- | --- | --- |
| Claude Code | `>=2.1.322 <2.2.0` | `>=2.2.0` (newer, never checked) | `<2.1.322` or unrecognised output |
| Codex CLI | `>=0.167.0 <0.167.1` | `>0.167.0` (newer, never checked) | `<0.167.0` or unrecognised output |

Only `supported` passes the check, because the worker adapters refuse any other version until the
range is widened after a fresh live capture. A CLI that is not installed is reported
`not-installed` and passes, provided the other one is supported.

## Coordinator environment (Windows)

| Component | Version | Status   | Checked | Evidence                       |
| --------- | ------- | -------- | ------- | ------------------------------ |
| Windows   | 11      | untested | —       | ADR-0012; verified by OMI-005  |

## How to re-check

- Claude Code worker: `OMI_LIVE_CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/<id> npm run test:live`,
  then read `.tmp/live/omi-002-claude-subscription-evidence.json` and update the rows above with
  the date and versions it records. Never paste the raw event stream or auth output here.

## Release PO approval gate (OMI-038)

`checkReleaseMerge` is a read-only application gate for the release PR `develop` → `main`.
The trusted release workflow supplies the repository, PR number, expected head SHA, PO login
allowlist and required check names. Native reviews come from the existing task-delivery reader:
the latest decisive review per human identity counts, only on the current head, excluding both
the author and runtime credential identity. A PO review cannot be replaced by an ordinary
reviewer, an approval comment or worker JSON. A push makes an older PO review stale even when
GitHub retains its approval. Workflow, active ruleset and classic branch-protection check names
are combined; the highest native approval count applies, with a minimum of one.

Unavailable/malformed reviews, rulesets, checks, PR state or permission data return typed
refusals. Classic branch protection is read separately because the branch-rules API reports
rulesets. Its REST endpoint requires Administration (read) for fine-grained tokens
([GitHub documentation](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)).
An ambiguous protection 404 fails closed, including for repository admins whose credential
may have narrower scopes. Thus a ruleset-only branch without readable classic protection is
refused even if GitHub would allow its merge. Configure readable classic protection alongside
rulesets for this gate. Classic push restrictions require an explicitly
listed user; team/app membership is not inferred. Locked branches, missing write permission and
non-clean mergeability refuse. These conservative refusals never request a bypass.

The result is a snapshot, not a stored authorization. Re-run immediately before a merge and use
the expected SHA as GitHub's merge guard. This task adds no release merge write path; the task
merge outbox remains restricted to `develop`. GitHub remains authoritative for restrictions and
credential scopes at the eventual merge. Live merge attempts and server refusal responses are
not exercised by the read-only probe below.

### Opt-in sandbox verification

After PO authorization, prepare a repository whose name contains `sandbox`, distinct from
`omi-hub-services/omi`, with an open `develop` → `main` release PR. Configure native required
reviews and at least one required check on `main`; checks must be green on the head. Use a
logged-in `gh` runtime account distinct from the PR author/PO as appropriate, with repository
write access and readable reviews, rulesets and classic protection. No token belongs in the config or evidence.

Create an untracked JSON config outside source, for example `.tmp/live/release-config.json`:

```json
{
  "scenario": "approved",
  "request": {
    "repository": "example/omi-sandbox",
    "prNumber": 5,
    "expectedHeadSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "poActors": ["example-po"],
    "requiredChecks": ["ci"]
  }
}
```

Select the file directly (do not run the whole live suite):

```sh
OMI_LIVE_RELEASE_CONFIG=.tmp/live/release-config.json npx vitest run tests/live/github/release-approval.test.ts
```

Run the same read-only probe against three manually prepared snapshots, updating config each time:

- `missing-po`: no approving reviews, green checks; verifies GitHub reports native mergeability
  `blocked` and the gate refuses missing PO approval.
- `approved`: the distinct PO submitted a native review on the exact current head; the gate permits.
- `stale-po`: push a new head without a new PO review and update `expectedHeadSha`. Keep the old
  PO review visible (disable GitHub's automatic stale-review dismissal for this sandbox phase);
  the gate refuses `PO_APPROVAL_STALE` even if GitHub retains approval. If GitHub dismisses the
  review instead, use `missing-po` after preparing a snapshot with no `APPROVED` reviews.

Every scenario also verifies that a mismatched expected head refuses. The probe enforces GET-only
access to the sandbox and `/user`, never submits a review or merge, skips when the environment
variable is unset, and fails for an empty/invalid explicit config. Evidence is written to
`.tmp/live/omi-038-release-approval-evidence.json` (copy it between phases if retaining all runs).
It is outside `npm run check` and default CI. Contract tests exercise the same adapter through
`tests/contract/github/fake-github.ts`, including missing permissions and classic restrictions.

## Offline reconciliation (2026-11-13)

[CLI verification](cli-verification.md) checks local build/help/negative paths; it does not
upgrade any live support claim. ADR-0031 also proves two concurrent Codex workers on one profile
and namespace isolation; concurrent refresh and cross-profile failover remain unproven. Its PO
resolution keeps one Codex profile: Codex-only work waits for quota, compatible work may switch
tools. Historical OMI-002/003 rows above retain their original versions and dates.
