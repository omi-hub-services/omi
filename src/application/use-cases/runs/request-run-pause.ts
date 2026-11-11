import { z } from "zod";
import { identifierSchema } from "../../contracts/identifiers.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type { PauseRunResult } from "./pause-run.js";

const requestRunPauseSchema = z.strictObject({
  runId: identifierSchema,
  reason: z.string().trim().min(1).max(500),
});

export interface RequestRunPauseDependencies {
  readonly session: Pick<ProjectSession, "record">;
  readonly pause: (input: unknown) => Promise<PauseRunResult>;
}

/**
 * The Coordinator's pause: records who asked and why in the audit trail, then pauses the run at
 * a checkpoint with its workers stopped. The reason is audit text only; it is never executed.
 */
export async function requestRunPause(
  deps: RequestRunPauseDependencies,
  input: unknown,
): Promise<PauseRunResult> {
  const parsed = requestRunPauseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const paused = await deps.pause({ runId: parsed.data.runId });
  if (paused.ok) {
    deps.session.record("run.pause_requested", {
      runId: parsed.data.runId,
      reason: parsed.data.reason,
      checkpointId: paused.checkpointId,
    });
  }
  return paused;
}
