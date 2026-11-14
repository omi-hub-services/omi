import { z } from "zod";
import { transitionRun } from "../../../domain/runs/workflow-run.js";
import { identifierSchema } from "../../contracts/identifiers.js";
import { mergeTaskPrSchema } from "../../contracts/merge-delivery.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type { RunPlanStore } from "../../ports/run-plan-store.js";
import type { RecoveryRunReader } from "../../ports/run-recovery.js";
import { DeliveryError } from "../../ports/pr-delivery.js";
import { mergeTaskPr } from "./merge-task-pr.js";
import type { MergeTaskPrDeps, MergeTaskPrResult } from "./merge-task-pr.js";

const deliverRunSchema = z.strictObject({
  runId: identifierSchema,
  ...mergeTaskPrSchema.pick({
    prNumber: true,
    reviewedHeadSha: true,
    requiredChecks: true,
    minimumNativeApprovals: true,
  }).shape,
});

export interface DeliverRunDependencies {
  readonly runs: RecoveryRunReader;
  readonly plans: Pick<RunPlanStore, "forRun">;
  readonly merge: MergeTaskPrDeps;
  readonly session: Pick<ProjectSession, "commit">;
  readonly nextId: () => string;
}

export type DeliverRunResult =
  | {
      readonly ok: true;
      readonly status: "done" | "pending";
      readonly delivery: MergeTaskPrResult;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly detail?: string;
    };

/**
 * The run's final gate: once every step has succeeded, merge the reviewed head into `develop`
 * through `mergeTaskPr` (review, head/base, checks, confirmed merge, tick, close, task Done) and
 * only then mark the run succeeded. Safe to call again after `pending` or a crash: the merge use
 * case reads back its earlier operations first.
 */
export async function deliverRun(
  deps: DeliverRunDependencies,
  input: unknown,
): Promise<DeliverRunResult> {
  const parsed = deliverRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const { runId, ...request } = parsed.data;
  const run = deps.runs.get(runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  if (run.status !== "running" && run.status !== "succeeded")
    return { ok: false, reason: "RUN_NOT_DELIVERABLE" };
  const steps = deps.runs.listSteps(runId);
  if (!steps.every((step) => step.status === "succeeded"))
    return { ok: false, reason: "STEPS_NOT_SUCCEEDED" };
  const task = deps.plans.forRun(runId);
  if (task === undefined) return { ok: false, reason: "TASK_NOT_FOUND" };

  let delivery: MergeTaskPrResult;
  try {
    delivery = await mergeTaskPr(deps.merge, {
      ...request,
      projectId: task.projectId,
      taskId: task.taskId,
      repository: task.repository,
      issueNumber: task.issueNumber,
    });
  } catch (error) {
    if (!(error instanceof DeliveryError)) throw error;
    return { ok: false, reason: error.code };
  }
  if (delivery.status === "refused") {
    return {
      ok: false,
      reason: "MERGE_REFUSED",
      detail: `${delivery.step}: ${delivery.reasons.join(",")}`,
    };
  }
  if (delivery.status === "pending") return { ok: true, status: "pending", delivery };

  if (run.status === "running") {
    const completed = transitionRun("running", {
      type: "complete",
      allStepsSucceeded: true,
      mandatoryGatesPassed: true,
    });
    if (!completed.ok) return { ok: false, reason: "STATE_REJECTED", detail: completed.reason };
    const committed = deps.session.commit({
      target: {
        kind: "workflow_run",
        id: run.id,
        expectedVersion: run.version,
        toStatus: completed.to,
      },
      event: {
        eventId: deps.nextId(),
        kind: "run.succeeded",
        subject: run.id,
        runId: run.id,
        correlationId: run.id,
        payload: JSON.stringify({ mergeCommitSha: delivery.mergeCommitSha }),
      },
    });
    if (!committed.ok) return { ok: false, reason: "STATE_REJECTED", detail: committed.reason };
  }
  return { ok: true, status: "done", delivery };
}
