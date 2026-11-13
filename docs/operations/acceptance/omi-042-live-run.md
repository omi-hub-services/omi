# OMI-042 live acceptance run (2026-11-13)

A factual record of the real, PO-approved sandbox run of the full lifecycle (idea → task →
develop → release → deploy). It comes from the harness report
(`/home/ttin/omi-runs/omi-042-live-evidence.json`, a copy of `.tmp/live/omi-042-<acceptanceId>.json`)
and the run facts below. It holds no credential, token or local secret.

## Run

| Item        | Value                                                               |
| ----------- | ------------------------------------------------------------------- |
| Acceptance  | `omi042-20261113`                                                   |
| Repository  | `omi-hub-services/omi-sandbox`                                      |
| Harness     | `tests/live/github/full-lifecycle.test.ts`: passed, 1 test, 246 s   |
| Framework   | `develop` at `8a3cd9d`                                              |
| PO / author | PO `ttin-omihub`; agent account `minibox-claude-code` (never the PO) |

## Gate 1: business approval (durable, not a native GitHub gate)

- Approval `d3722dbf-64d2-4e0e-b9c7-381ef1acba82` for task `task-9`, baseline
  `287db8a256e1cc97e408076aae25e20af3f8a0bc91202dab923a3c705e92dd15`.
- Recorded from a `ttin-omihub` GitHub comment (source `github-actor`) through `approvals decide`.

## Task to develop

- Harness opened task Issue #10; task PR #11 merged to `develop` (merge commit
  `18ad75ddf86ead5437584bcced8be7627403833c`), result `done`.
- Independent review: reviewer run `codex-thread:01a1d35f-c221-79c0-8150-2153ecb1687a`
  (agent `codex-ggtintran`), verdict `pass` on head `bb59a747e197f765030fa196452de0af006c1244`
  (base `57e4b2a40a7b5d15b34c65ab785a78b3b71c4d73`), 0 unresolved mandatory findings.
- Author: `claude-session:15716048-4d7b-445d-ac2d-db932317ecd6` (agent `claude-minibox`), a
  different run and agent from the reviewer.

## Gate 2: release (native GitHub review)

- Release Issue #13 and `develop` → `main` PR #14; the release listed PR #11 and PR #12
  (sandbox workflow sync).
- `ttin-omihub` approved natively on head `18ad75ddf86ead5437584bcced8be7627403833c`
  (`APPROVED`, `commitSha` equal to the pinned head); gate result `allowed: true`.
- PR #14 merged to `main`; tag `omi042-20261113` at `d537a178e5bc1bfacb01bb4e2cc574ba6abd480a`;
  release `published`.

## Gate 3: deploy (durable approval and native environment approval)

- Deploy approval `b11039e0-dba1-4c66-b3a6-5502f3793574` for digest
  `sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10`, environment
  `sandbox`, recorded from a `ttin-omihub` GitHub comment (source `github-actor`).
- Workflow run `43378059886`: `completed`, `success`; deployment `7758767655`: `success`;
  the deployed digest equals the approved digest; `nativeApproved: true`. Result `verified`.

## What this shows against the Issue

- AC-1: the idea → task → develop → release → deploy chain ran end to end in the sandbox.
- AC-2: evidence is complete (above) and the two approvals are separate: the durable business
  and deploy decisions, and the native release review and environment approval. Release
  approval alone does not pass the deploy gate (offline e2e proves it).
- AC-3: the PO approved for real at the release and deploy gates.

## Found and fixed during the run

- #204: release gate rulesets.
- #206: harness resume.
- `omi-hub-services/omi-sandbox#12`: sandbox `develop` was missing the workflows.
- Runbook notes in `docs/operations/deploy-runbook.md`.

## Limits

The run used the sandbox repository and an image digest the operator verified by hand; there is
no provenance port linking a Git commit to a container digest. The harness is a use-case
acceptance harness, not proof of a complete CLI installation or GitHub Project synchronization.
