import { z } from "zod";
import { RUN_STATUSES } from "../../../domain/runs/workflow-run.js";
import { STEP_STATUSES } from "../../../domain/runs/step-run.js";
import { identifierSchema, slugSchema } from "../../../application/contracts/identifiers.js";
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

export function createSqliteRecoveryRunReader(db: StateDatabase): RecoveryRunReader {
  const run = db.prepare("SELECT id, status, version FROM workflow_runs WHERE id = ?");
  const steps = db.prepare(
    "SELECT id, run_id AS runId, step_key AS stepId, status, version FROM step_runs WHERE run_id = ? ORDER BY rowid",
  );
  return {
    get(runId) {
      const row = run.get(runId);
      return row === undefined ? undefined : runSchema.parse(row);
    },
    listSteps: (runId) => z.array(stepSchema).parse(steps.all(runId)),
  };
}
