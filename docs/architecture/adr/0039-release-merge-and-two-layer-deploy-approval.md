# ADR-0039: Release merge use case and two-layer deploy approval

Date: 2026-11-13
Status: Accepted (PO decision of 2026-11-13 recorded in Issue #215)

## Context

The product had `checkReleaseMerge` (ADR-0034 family, OMI-038) but no way to merge the release
PR `develop` → `main`. The live harness issued its own `PUT pulls/{n}/merge`. The PO also had to
decide whether the durable deploy approval (by artifact digest) and GitHub's native environment
approval should stay separate or be merged into one.

## Decision

1. **`mergeRelease`** (`src/application/use-cases/delivery/merge-release.ts`) is the only product
   path that merges a release PR. It reads back any earlier attempt, then runs `checkReleaseMerge`
   (native PO approval on the exact head, checks, permissions, mergeability). Only when the gate
   allows does it queue `pull_request.merge` with `base: main` and `expectedHeadSha` = the PO-approved
   head; the adapter sends the native merge with `sha` pinned to that head and a merge commit. The
   merge commit must then be on `main` with the approved head as a parent. A refusal is returned
   with the gate's reasons and its step (`gate`, `merge`, `confirm`); nothing retries around it or
   requests a bypass.
2. **Idempotency.** The outbox key is `merge-release:<repo>#<pr>@<head>`. A retry reconciles the key
   first, never sends a second PUT for a merged PR, and an already merged PR is only confirmed. The
   PR is correlated to its release through the creation marker of `releasePullKey(repo, release)`.
3. **Command.** `merge-release --release <label> --pr <n> --head-sha <sha> [--check <name>]`
   sends `release.merge` over runtime IPC. The runtime supplies the repository and the PO logins
   from `project.yaml`: the PO allowlist is the existing `policies.github_approval_actors` (the one
   approvals use; no new key). The command cannot name or override PO logins, and an empty
   allowlist refuses (`PO_ACTORS_NOT_CONFIGURED`) before any GitHub read.
   An unreadable, malformed or foreign PR on the first read refuses with `PR_READ_UNAVAILABLE` or
   `PR_IDENTITY_MISMATCH` and sends nothing.
4. **Keep both deploy approval layers** (PO, 2026-11-13). The durable approval by artifact digest
   (ADR-0037, `deployRelease`) and GitHub's native environment approval (required User reviewers,
   `prevent_self_review`, no admin bypass) both stay. Neither replaces the other, and release merge
   approval replaces neither. This ADR changes neither layer.

## Consequences

- `pull_request.merge` accepts `base` `develop` (task PRs, `mergeTaskPr`) or `main` (release PR,
  `mergeRelease`). The adapter still decides no gate; each use case does before it queues.
- The live harness calls `mergeRelease` instead of a hand-written PUT.
- No merge lock is taken for `main`: a release merge runs serially on the runtime writer and GitHub's
  `sha` guard refuses a moved head.
