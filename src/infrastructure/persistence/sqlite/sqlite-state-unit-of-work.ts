import type {
  LeaseFence,
  StateChange,
  StateCommitResult,
  StateUnitOfWork,
} from "../../../application/ports/state-unit-of-work.js";
import { assertIsoUtc } from "./sqlite-lease-store.js";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

const TABLE_BY_KIND = {
  workflow_run: "workflow_runs",
  step_run: "step_runs",
} as const;

/**
 * StateUnitOfWork over SQLite: lease check, version compare-and-swap, event append and outbox
 * insert in one BEGIN IMMEDIATE transaction. Every rejection is decided before the first write,
 * so a rejected change leaves nothing behind; a failing insert throws and rolls back the state
 * update as well.
 */
export function createSqliteStateUnitOfWork(
  db: StateDatabase,
  projectFence?: LeaseFence,
): StateUnitOfWork {
  const selectLease = db.prepare(
    "SELECT owner, generation, expires_at FROM leases WHERE resource_key = ?",
  );
  const cas = {
    workflow_run: db.prepare(
      // A finished run is closed in the same statement, which frees the one-active-run-per-task
      // index for a later run of the same task.
      `UPDATE ${TABLE_BY_KIND.workflow_run} SET status = ?, version = version + 1, updated_at = ?,
         closed_at = CASE WHEN ? IN ('succeeded', 'cancelled') THEN ? ELSE closed_at END
       WHERE id = ? AND version = ?`,
    ),
    step_run: db.prepare(
      `UPDATE ${TABLE_BY_KIND.step_run} SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
    ),
  };
  const exists = {
    workflow_run: db.prepare(`SELECT 1 FROM ${TABLE_BY_KIND.workflow_run} WHERE id = ?`),
    step_run: db.prepare(`SELECT 1 FROM ${TABLE_BY_KIND.step_run} WHERE id = ?`),
  };
  const insertEvent = db.prepare(
    `INSERT INTO events (event_id, kind, subject, run_id, causation_id, correlation_id, payload, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertOutbox = db.prepare(
    `INSERT INTO outbox (operation_key, kind, subject, payload_ref, payload_hash, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );

  return {
    commit(change: StateChange): StateCommitResult {
      assertIsoUtc(change.at, "at");
      const { target, fence, event, outbox } = change;
      return runInTransaction(db, (): StateCommitResult => {
        for (const fence of [projectFence, change.fence]) {
          if (fence === undefined) continue;
          const lease = selectLease.get(fence.resourceKey) as
            { owner: string; generation: number; expires_at: string } | undefined;
          if (
            lease === undefined ||
            lease.owner !== fence.owner ||
            lease.generation !== fence.generation
          ) {
            return { ok: false, reason: "STALE_LEASE" };
          }
          if (lease.expires_at <= change.at) return { ok: false, reason: "LEASE_EXPIRED" };
        }

        let newVersion: number;
        if (target.kind === "task_snapshot") {
          const s = target.snapshot;
          if (db.prepare("SELECT 1 FROM projects WHERE id = ?").get(s.projectId) === undefined)
            return { ok: false, reason: "NOT_FOUND" };
          const byIssue = db
            .prepare(
              "SELECT id, issue_number, content_hash FROM task_snapshots WHERE project_id = ? AND issue_node_id = ?",
            )
            .get(s.projectId, s.issueNodeId) as
            { id: string; issue_number: number; content_hash: string } | undefined;
          if (byIssue?.content_hash === s.contentHash && byIssue.id === s.id)
            return { ok: false, reason: "UNCHANGED" };
          // The id and Issue number must each belong to this Issue only, or be free.
          const holder = db
            .prepare(
              "SELECT issue_node_id FROM task_snapshots WHERE (project_id = ? AND issue_number = ?) OR id = ?",
            )
            .all(s.projectId, s.issueNumber, s.id) as { issue_node_id: string }[];
          if (holder.some((row) => row.issue_node_id !== s.issueNodeId))
            return { ok: false, reason: "CONFLICT" };
          if (byIssue !== undefined && byIssue.id !== s.id)
            return { ok: false, reason: "CONFLICT" };
          if (byIssue === undefined) {
            db.prepare(
              `INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash,
               remote_updated_at, scope, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              s.id,
              s.projectId,
              s.issueNodeId,
              s.issueNumber,
              s.contentHash,
              s.remoteUpdatedAt,
              s.scope,
              change.at,
            );
          } else {
            db.prepare(
              `UPDATE task_snapshots SET issue_number = ?, content_hash = ?, remote_updated_at = ?,
               scope = ?, captured_at = ? WHERE id = ?`,
            ).run(s.issueNumber, s.contentHash, s.remoteUpdatedAt, s.scope, change.at, s.id);
          }
          newVersion = 0;
        } else if (target.kind === "session_event") {
          if (fence === undefined) throw new Error("session_event requires a lease fence");
          newVersion = 0;
        } else if (target.kind === "outbox_intent") {
          if (outbox === undefined) throw new Error("outbox_intent requires an outbox entry");
          if (db.prepare("SELECT 1 FROM outbox WHERE operation_key = ?").get(outbox.operationKey)) {
            return { ok: false, reason: "ALREADY_EXISTS" };
          }
          newVersion = 0;
        } else if (target.kind === "approval_request" || target.kind === "approval_decision") {
          const request = target.request;
          const decision = request.decision;
          const values = [
            request.runId ?? null,
            request.subject.kind,
            request.subjectHash,
            decision?.actor ?? null,
            decision?.source ?? null,
            decision?.decision ?? null,
            request.subjectHash,
            decision === undefined ? null : new Date(decision.decidedAt).toISOString(),
            request.expiresAt === undefined ? null : new Date(request.expiresAt).toISOString(),
            request.status,
            request.version,
            JSON.stringify(request),
          ];
          if (target.kind === "approval_request") {
            if (db.prepare("SELECT 1 FROM approvals WHERE id = ?").get(request.id) !== undefined) {
              return { ok: false, reason: "ALREADY_EXISTS" };
            }
            db.prepare(
              `INSERT INTO approvals (run_id, kind, subject_hash, actor, channel, decision,
              revision, decided_at, expires_at, status, version, request_json, id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(...values, request.id);
          } else {
            if (request.version !== target.expectedVersion + 1)
              throw new Error("approval version must advance once");
            const updated = db
              .prepare(
                `UPDATE approvals SET run_id=?, kind=?, subject_hash=?, actor=?,
              channel=?, decision=?, revision=?, decided_at=?, expires_at=?, status=?, version=?, request_json=?
              WHERE id=? AND version=?`,
              )
              .run(...values, request.id, target.expectedVersion);
            if (updated.changes === 0) {
              const found =
                db.prepare("SELECT 1 FROM approvals WHERE id=?").get(request.id) !== undefined;
              return { ok: false, reason: found ? "STALE_VERSION" : "NOT_FOUND" };
            }
          }
          newVersion = request.version;
        } else {
          const updated =
            target.kind === "workflow_run"
              ? cas.workflow_run.run(
                  target.toStatus,
                  change.at,
                  target.toStatus,
                  change.at,
                  target.id,
                  target.expectedVersion,
                )
              : cas.step_run.run(target.toStatus, change.at, target.id, target.expectedVersion);
          if (updated.changes === 0) {
            const found = exists[target.kind].get(target.id) !== undefined;
            return { ok: false, reason: found ? "STALE_VERSION" : "NOT_FOUND" };
          }

          newVersion = target.expectedVersion + 1;
          if (target.kind === "workflow_run" && target.rework !== undefined) {
            const state = target.rework;
            db.prepare(
              `UPDATE workflow_runs SET quality_phase=?, failure_count=?,
               architect_intervention_id=?, counted_cycle_ids=?, reopen_decision_ids=? WHERE id=?`,
            ).run(
              state.phase,
              state.failedCycles,
              state.architectInterventionId ?? null,
              JSON.stringify(state.countedCycleIds),
              JSON.stringify(state.reopenDecisionIds),
              target.id,
            );
          }
        }

        const appended = insertEvent.run(
          event.eventId,
          event.kind,
          event.subject,
          event.runId ?? null,
          event.causationId ?? null,
          event.correlationId,
          event.payload,
          change.at,
        );
        if (outbox !== undefined) {
          insertOutbox.run(
            outbox.operationKey,
            outbox.kind,
            outbox.subject,
            outbox.payloadRef,
            outbox.payloadHash,
            change.at,
            change.at,
          );
        }
        return {
          ok: true,
          newVersion,
          eventSequence: Number(appended.lastInsertRowid),
        };
      });
    },
  };
}
