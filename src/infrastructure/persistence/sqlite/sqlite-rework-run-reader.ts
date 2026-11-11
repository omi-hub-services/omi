import { z } from "zod";
import { reworkStateSchema } from "../../../application/contracts/rework.js";
import type { ReworkRunReader } from "../../../application/ports/rework-run-reader.js";
import { RUN_STATUSES } from "../../../domain/runs/workflow-run.js";
import type { StateDatabase } from "./sqlite-connection.js";

const rowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  status: z.enum(RUN_STATUSES),
  version: z.number().int().nonnegative(),
  quality_phase: z.string(),
  failure_count: z.number(),
  architect_intervention_id: z.string().nullable(),
  counted_cycle_ids: z.string(),
  reopen_decision_ids: z.string(),
});

export function createSqliteReworkRunReader(db: StateDatabase): ReworkRunReader {
  const select = db.prepare("SELECT * FROM workflow_runs WHERE id = ?");
  return {
    get(runId) {
      const raw = select.get(runId);
      if (raw === undefined) return undefined;
      const row = rowSchema.parse(raw);
      const state = reworkStateSchema.parse({
        phase: row.quality_phase,
        failedCycles: row.failure_count,
        ...(row.architect_intervention_id === null
          ? {}
          : { architectInterventionId: row.architect_intervention_id }),
        countedCycleIds: JSON.parse(row.counted_cycle_ids) as unknown,
        reopenDecisionIds: JSON.parse(row.reopen_decision_ids) as unknown,
      });
      return {
        id: row.id,
        taskId: row.task_id,
        status: row.status,
        version: row.version,
        rework: {
          phase: state.phase,
          failedCycles: state.failedCycles,
          countedCycleIds: state.countedCycleIds,
          reopenDecisionIds: state.reopenDecisionIds,
          ...(state.architectInterventionId === undefined
            ? {}
            : { architectInterventionId: state.architectInterventionId }),
        },
      };
    },
  };
}
