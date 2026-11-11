import { z } from "zod";
import type { StateDatabase } from "./sqlite-connection.js";
import type { AttemptStore } from "../../../application/ports/attempt-store.js";
import type { TaskCompletionStore } from "../../../application/ports/merge-delivery.js";
import type { ProjectSession } from "../../../application/ports/lease-store.js";
import { stepResultSchema } from "../../../application/contracts/result.js";
import type { RunDeliverySource } from "../../../application/ports/run-delivery-source.js";
import { runInTransaction } from "./sqlite-transaction.js";

export function createSqliteRunDeliveryStore(
  db: StateDatabase,
  attempts: AttemptStore,
  session: ProjectSession,
): { source: RunDeliverySource; tasks: TaskCompletionStore } {
  const status: TaskCompletionStore["status"] = (projectId, taskId) => {
    if (
      db
        .prepare("SELECT 1 FROM task_snapshots WHERE id=? AND project_id=?")
        .get(taskId, projectId) === undefined
    )
      return undefined;
    return db
      .prepare(
        "SELECT 1 FROM events WHERE kind='task.done' AND json_extract(payload, '$.taskId')=? AND json_extract(payload, '$.projectId')=?",
      )
      .get(taskId, projectId) === undefined
      ? "in_progress"
      : "done";
  };
  return {
    tasks: {
      status,
      complete: (change) =>
        runInTransaction(db, () => {
          const current = status(change.projectId, change.taskId);
          if (current === undefined) return { ok: false as const, reason: "NOT_FOUND" as const };
          if (current !== change.expectedStatus)
            return { ok: false as const, reason: "STALE_STATUS" as const };
          session.record("task.done", { ...change });
          return { ok: true as const };
        }),
    },
    source: {
      read(projectId, taskId) {
        const rows = db
          .prepare(
            `SELECT e.payload FROM events e JOIN workflow_runs r ON r.id=e.run_id
          JOIN task_snapshots t ON t.id=r.task_id WHERE t.id=? AND t.project_id=? AND e.kind='step.succeeded' ORDER BY e.sequence`,
          )
          .all(taskId, projectId);
        const entries = rows.map((row) => {
          const payload = z
            .object({ attemptId: z.string(), result: stepResultSchema })
            .parse(JSON.parse(z.object({ payload: z.string() }).parse(row).payload));
          const attempt = attempts.get(payload.attemptId);
          if (attempt === undefined) throw new Error("ATTEMPT_NOT_FOUND");
          return { attempt, result: payload.result };
        });
        const unfinished = db
          .prepare(
            `SELECT 1 FROM step_runs s JOIN workflow_runs r ON r.id=s.run_id WHERE r.task_id=? AND r.closed_at IS NULL AND s.status<>'succeeded'`,
          )
          .get(taskId);
        return { entries, allStepsSucceeded: unfinished === undefined };
      },
    },
  };
}
