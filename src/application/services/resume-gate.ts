import type { CheckpointManifest } from "../contracts/checkpoint.js";
import type { RecoveryGate } from "../ports/run-recovery.js";
import { DispatchPlanningError } from "./dispatch-planning-error.js";

export interface ResumeGateDependencies {
  readonly plans: {
    forRun(runId: string): { readonly taskId: string; readonly templateHash: string } | undefined;
  };
  readonly configHash: string;
  /** The OMI-126 task reader: it throws a DispatchPlanningError unless an approval is current. */
  readonly taskReader: {
    read(taskId: string): Promise<{
      readonly context: {
        readonly businessBaselineHash: string;
        readonly approvalRefs: readonly string[];
      };
    }>;
  };
}

/** Config/template must be unchanged. A changed business baseline is accepted only when the task
 * reader proves a current approval for the new hash (OMI-128); the resume then reports a rebaseline
 * so the audit trail records it. The old attempt is never reused: dispatch starts a fresh attempt.
 */
export function createResumeGate(deps: ResumeGateDependencies): RecoveryGate {
  return async (checkpoint: CheckpointManifest) => {
    const plan = deps.plans.forRun(checkpoint.runId);
    if (
      plan === undefined ||
      plan.templateHash !== checkpoint.hashes.template ||
      checkpoint.hashes.config !== deps.configHash
    )
      return { ok: false, reason: "CONFIG_OR_TEMPLATE_CHANGED" };
    try {
      const current = await deps.taskReader.read(plan.taskId);
      const to = current.context.businessBaselineHash;
      return to === checkpoint.businessBaselineHash
        ? { ok: true }
        : {
            ok: true,
            rebaseline: {
              from: checkpoint.businessBaselineHash,
              to,
              approvalIds: [...current.context.approvalRefs],
            },
          };
    } catch (error) {
      // A stale or missing business approval is a gate refusal, not a crash.
      if (error instanceof DispatchPlanningError) return { ok: false, reason: error.reason };
      throw error;
    }
  };
}
