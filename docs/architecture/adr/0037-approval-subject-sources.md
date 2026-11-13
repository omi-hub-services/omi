# ADR-0037 — Approval subject sources and imported task snapshots

- Status: Accepted
- Date: 2026-11-13
- Issue: #196 (OMI-095), unblocks AC-3 of #49 (OMI-042)
- Context: ADR-0026 (approval decisions), ADR-0032 (task import), architecture.md §8, §13

## Context

A real approval run needs a business and a deploy approval request in `state.db`, but nothing
could create them. `importTask` returned snapshots only in memory, so the business subject reader
(which reads `task_snapshots.content_hash`) found nothing. The deploy subject had no reader, and no
CLI created a request. The subject of an approval must come from a trusted record, never from the
caller, or the caller could pick what the PO approves.

## Decision

1. **Task snapshots are stored by a use case.** `storeTaskSnapshots`
   (`application/use-cases/tasks/`) takes an `importTask` result and commits one `task_snapshot`
   change per snapshot through `StateUnitOfWork`, with a `task.imported` audit event. It upserts on
   `(project_id, issue_node_id)`; the same `content_hash` is a no-op (`UNCHANGED`, no event); an
   Issue number or task id held by another Issue is a typed rejection (`ISSUE_NUMBER_CONFLICT`). It
   recomputes each hash, so a forged `contentHash` is refused. The local task id is
   `task-<Issue number>`. The project row must already exist (created by session/sandbox setup).
   `task_dependencies` is not written here.
2. **Who imports.** The import is not an IPC command or CLI. A setup tool (sandbox `live-prep`)
   calls `importTask` and `storeTaskSnapshots` in-process **before** the runtime session starts,
   because the session holds the state lease. This order is documented in the deploy runbook.
3. **Business baseline** is the snapshot's `content_hash` (the reviewed Issue content), scope = the
   task id. A re-import with changed content makes older requests stale.
4. **Deploy subject** comes from an optional, strict `deploy_targets: [{id, target_environment,
artifact_digest}]` in `project.yaml` (`artifact_digest` is `sha256:<64 hex>`; ids unique,
   enforced by the schema). The key is `target_environment`, not `environment`: the
   credential-input guard rejects a config key named `environment`, and the guard is not relaxed. `createConfigDeploySubjects` reads only that validated config and fails
   closed on an unknown or duplicated id. Each release edits the entry and restarts the session; the
   subject hash is `[artifactDigest, environment]`, so a changed digest or environment makes an old
   approval stale (`STALE_REVISION`). Alternatives rejected: a stored release/deploy intent table
   (new schema and writer for one field) and the live environment configuration on GitHub (not
   immutable per release).
5. **Composition.** `composeApprovalSubjects` routes each kind to the one reader that owns it
   (`business` → SQLite snapshots, `deploy` → config); cost and release have no reader and fail
   closed. It is wired in `container.ts`.
6. **`omi approvals request <subject-id> --kind business|deploy`** sends `approval.request` over
   runtime IPC and prints the request id and version. It has no decision, actor or source flag;
   the only way to `approved` stays `approvals decide` (ADR-0026). The no-project runtime stub is
   unchanged.

## Consequences

- A deploy approval is bound to config the project reviews through a normal PR, not to a value typed
  at request time. Changing a target after approval invalidates it rather than silently approving
  the new digest.
- A new `StateTarget` (`task_snapshot`) and two rejections (`UNCHANGED`, `CONFLICT`) extend the
  unit-of-work port; no migration is needed (`task_snapshots` exists since 0001).
- The rollback runbook business approval (`baselineHash = revisionHash`) is a different subject
  with no reader or request command yet. It is out of scope here.
