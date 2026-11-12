import { z } from "zod";
import { workflowQualityPlanSchema } from "../../../application/contracts/workflow.js";
import type { RunPlanStore } from "../../../application/ports/run-plan-store.js";
import type { LeaseFence } from "../../../application/ports/state-unit-of-work.js";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

const taskRow = z.strictObject({
  taskId: z.string(),
  projectId: z.string(),
  repository: z.string(),
  issueNumber: z.number().int().positive(),
});
const runTaskRow = taskRow.extend({ templateHash: z.string() });

/** Run rows over `workflow_runs`, `step_runs`, `task_snapshots` and `projects`. */
export function createSqliteRunPlanStore(
  db: StateDatabase,
  options?: { readonly fence: LeaseFence; readonly now: () => number },
): RunPlanStore {
  const task = db.prepare(
    `SELECT t.id AS taskId, t.project_id AS projectId, p.repo_identity AS repository,
            t.issue_number AS issueNumber
       FROM task_snapshots t JOIN projects p ON p.id = t.project_id
      WHERE t.issue_number = ? ORDER BY t.captured_at DESC LIMIT 1`,
  );
  const forRun = db.prepare(
    `SELECT t.id AS taskId, t.project_id AS projectId, p.repo_identity AS repository,
            t.issue_number AS issueNumber, r.template_hash AS templateHash
       FROM workflow_runs r
       JOIN task_snapshots t ON t.id = r.task_id
       JOIN projects p ON p.id = t.project_id
      WHERE r.id = ?`,
  );
  const active = db.prepare("SELECT 1 FROM workflow_runs WHERE task_id = ? AND closed_at IS NULL");
  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, version, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 'normal', 0, ?, ?)`,
  );
  const insertStep = db.prepare(
    `INSERT INTO step_runs (id, run_id, step_key, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (event_id, kind, subject, run_id, causation_id, correlation_id, payload, occurred_at)
     VALUES (?, 'run.planned', ?, ?, NULL, ?, ?, ?)`,
  );
  return {
    findTask(issueNumber) {
      const row = task.get(issueNumber);
      return row === undefined ? undefined : taskRow.parse(row);
    },
    forRun(runId) {
      const row = forRun.get(runId);
      if (row === undefined) return undefined;
      const event = z
        .object({ payload: z.string() })
        .optional()
        .parse(
          db
            .prepare(
              "SELECT payload FROM events WHERE run_id = ? AND kind = 'run.planned' ORDER BY sequence LIMIT 1",
            )
            .get(runId),
        );
      const qualityPlan =
        event === undefined
          ? undefined
          : z
              .object({ qualityPlan: workflowQualityPlanSchema.optional() })
              .parse(JSON.parse(event.payload) as unknown).qualityPlan;
      return { ...runTaskRow.parse(row), ...(qualityPlan === undefined ? {} : { qualityPlan }) };
    },
    createRun(plan) {
      return runInTransaction(db, () => {
        if (
          options !== undefined &&
          db
            .prepare(
              "SELECT 1 FROM leases WHERE resource_key=? AND owner=? AND generation=? AND expires_at>?",
            )
            .get(
              options.fence.resourceKey,
              options.fence.owner,
              options.fence.generation,
              new Date(options.now()).toISOString(),
            ) === undefined
        )
          return { ok: false as const, reason: "PROJECT_LOCK_LOST" as const };
        if (active.get(plan.taskId) !== undefined) {
          return { ok: false as const, reason: "ACTIVE_RUN_EXISTS" as const };
        }
        insertRun.run(plan.runId, plan.taskId, plan.templateHash, plan.at, plan.at);
        for (const step of plan.steps) {
          insertStep.run(step.stepRunId, plan.runId, step.stepId, step.status, plan.at, plan.at);
        }
        insertEvent.run(
          plan.eventId,
          plan.runId,
          plan.runId,
          plan.runId,
          JSON.stringify({
            ...(plan.qualityPlan === undefined
              ? {}
              : { qualityPlan: workflowQualityPlanSchema.parse(plan.qualityPlan) }),
            templateHash: plan.templateHash,
            steps: plan.steps.map((step) => step.stepId),
          }),
          plan.at,
        );
        return { ok: true as const };
      });
    },
  };
}
