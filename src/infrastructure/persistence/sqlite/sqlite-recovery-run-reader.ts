import { z } from "zod";
import { RUN_STATUSES } from "../../../domain/runs/workflow-run.js";
import { STEP_STATUSES } from "../../../domain/runs/step-run.js";
import { identifierSchema, slugSchema } from "../../../application/contracts/identifiers.js";
import type { ActiveRunReader } from "../../../application/ports/active-run-reader.js";
import type { StepRunReader } from "../../../application/ports/attempt-store.js";
import type { RecoveryRunReader } from "../../../application/ports/run-recovery.js";
import type { StateDatabase } from "./sqlite-connection.js";

const runSchema = z.strictObject({
  id: identifierSchema,
  status: z.enum(RUN_STATUSES),
  version: z.number().int().nonnegative(),
});
const stepSchema = z.strictObject({
  id: identifierSchema,
  runId: identifierSchema,
  stepId: slugSchema,
  status: z.enum(STEP_STATUSES),
  version: z.number().int().nonnegative(),
});

export function createSqliteRecoveryRunReader(
  db: StateDatabase,
): RecoveryRunReader & ActiveRunReader {
  const run = db.prepare("SELECT id, status, version FROM workflow_runs WHERE id = ?");
  const steps = db.prepare(
    "SELECT id, run_id AS runId, step_key AS stepId, status, version FROM step_runs WHERE run_id = ? ORDER BY rowid",
  );
  const active = db.prepare(
    "SELECT id, status, version FROM workflow_runs WHERE closed_at IS NULL ORDER BY rowid",
  );
  return {
    get(runId) {
      const row = run.get(runId);
      return row === undefined ? undefined : runSchema.parse(row);
    },
    listSteps: (runId) => z.array(stepSchema).parse(steps.all(runId)),
    listActive: () => z.array(runSchema).parse(active.all()),
  };
}

/** One step run by its id, for dispatch and result recording. */
export function createSqliteStepRunReader(db: StateDatabase): StepRunReader {
  const step = db.prepare(
    "SELECT id, run_id AS runId, step_key AS stepId, status, version FROM step_runs WHERE id = ?",
  );
  return {
    get(stepRunId) {
      const row = step.get(stepRunId);
      return row === undefined ? undefined : stepSchema.parse(row);
    },
  };
}
