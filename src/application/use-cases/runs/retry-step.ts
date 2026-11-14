import { transitionStep } from "../../../domain/runs/step-run.js";
import { decideOperationalRetry, type RetryBudget } from "../../../domain/runs/retry-policy.js";
import { retryStepSchema } from "../../contracts/rework.js";
import type { DispatchTask } from "../../services/plan-step-dispatch.js";
import { packetModels, qualityStepId } from "../../services/plan-workflow-quality.js";
import type { ModelsConfig } from "../../contracts/model-capability.js";
import type { ProjectConfig } from "../../contracts/project-config.js";
import { failoverStep, type FailoverStepDependencies } from "../profiles/failover-step.js";
import {
  dispatchRunStep,
  type DispatchRunStepDependencies,
  type DispatchRunStepResult,
} from "./dispatch-run-step.js";
import { recordReworkEvent, type RecordReworkEventDependencies } from "./record-rework-event.js";

export interface RetryStepDependencies {
  readonly dispatch: DispatchRunStepDependencies;
  readonly rework: RecordReworkEventDependencies;
  /** Durable operational failures, excluding all quality rounds. */
  readonly operationalFailures: (stepRunId: string) => number;
  readonly retryBudget: RetryBudget;
  readonly failover?: {
    readonly dependencies: FailoverStepDependencies;
    readonly models: ModelsConfig;
    readonly effortPolicy: ProjectConfig["effort_policy"];
    readonly readTask: (taskId: string) => Promise<DispatchTask>;
  };
}

type RetryStepResult =
  | DispatchRunStepResult
  | { readonly ok: false; readonly reason: string; readonly detail?: string }
  | {
      readonly ok: true;
      readonly outcome: "waiting_resource" | "failed_over";
      readonly attemptId?: string;
    };

/** Retry obeys the live quality controller; dispatch/recovery alone allocate a new attempt. */
export async function retryStep(
  deps: RetryStepDependencies,
  input: unknown,
): Promise<RetryStepResult> {
  const parsed = retryStepSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const { runId, stepId, poDecisionId } = parsed.data;
  const { dispatch, rework } = deps;
  const canRetry = () => {
    const live = rework.runs.get(runId);
    return (
      live?.status === "running" &&
      (live.rework.phase === "normal" || live.rework.phase === "assisted") &&
      dispatch.canDispatch?.() !== false
    );
  };
  if (!rework.session.renew()) return { ok: false, reason: "PROJECT_LOCK_LOST" };
  let run = rework.runs.get(runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  if (run.status !== "running" && run.status !== "blocked")
    return { ok: false, reason: "RUN_NOT_RUNNING" };
  if (run.rework.phase === "architect") return { ok: false, reason: "ARCHITECT_REQUIRED" };
  const step = dispatch.runs.listSteps(runId).find((candidate) => candidate.stepId === stepId);
  if (step === undefined) return { ok: false, reason: "STEP_NOT_FOUND" };
  if (step.status !== "failed" && step.status !== "ready" && step.status !== "waiting_resource")
    return { ok: false, reason: "STEP_NOT_FAILED" };
  const latest = dispatch.attempts.latestForStep(step.id);
  if (latest === undefined || (latest.status !== "failed" && latest.status !== "interrupted"))
    return { ok: false, reason: "STEP_NOT_FAILED" };
  const qualityFailure = run.rework.countedCycleIds.includes(latest.id);
  if (!qualityFailure || step.status === "waiting_resource") {
    const action = decideOperationalRetry({
      failure: "network",
      retriesMade: Math.max(0, deps.operationalFailures(step.id) - 1),
      now: dispatch.now(),
      jitter: 0,
      budget: deps.retryBudget,
    });
    if (action.action === "stop") return { ok: false, reason: action.reason };
  }
  if (run.status === "blocked" || run.rework.phase === "blocked") {
    if (poDecisionId === undefined) return { ok: false, reason: "PO_DECISION_REQUIRED" };
    const reopened = await recordReworkEvent(rework, {
      runId,
      event: { type: "po_reopened", poDecisionId },
    });
    if (!reopened.ok) return reopened;
    run = rework.runs.get(runId);
    if (run?.status !== "running") return { ok: false, reason: "RUN_NOT_RUNNING" };
  }
  if (run.rework.phase !== "normal" && run.rework.phase !== "assisted")
    return { ok: false, reason: "REWORK_BUDGET_SPENT" };
  if (step.status === "waiting_resource") {
    const failover = deps.failover;
    const plan = dispatch.plans.forRun(runId);
    const workflow =
      plan?.qualityPlan?.workflow ??
      (plan === undefined ? undefined : dispatch.workflows.byHash(plan.templateHash)?.workflow);
    if (plan !== undefined && workflow === undefined)
      return {
        ok: false,
        reason: "TEMPLATE_UNAVAILABLE",
        detail: `template_hash=${plan.templateHash}`,
      };
    const definition = workflow?.steps.find((entry) => entry.id === stepId);
    if (failover === undefined || plan === undefined || definition === undefined)
      return { ok: false, reason: "NOT_PLANNABLE" };
    const task = await failover.readTask(plan.taskId);
    if (!canRetry()) return { ok: false, reason: "RUN_NOT_RUNNING" };
    const result = await failoverStep(
      {
        ...failover.dependencies,
        dispatch: (request) =>
          canRetry()
            ? failover.dependencies.dispatch(request)
            : Promise.resolve({ ok: false, reason: "RUN_NOT_RUNNING" }),
      },
      {
        runId,
        stepRunId: step.id,
        capabilityProfile: definition.capability_profile,
        models: packetModels(
          failover.models,
          plan.qualityPlan?.packets[stepId] ?? [definition],
          definition.capability_profile,
        ),
        task: {
          ...task.complexity,
          workflow: task.complexity.workflow ?? workflow?.id ?? null,
          acCount: task.context.acceptanceCriteria.length,
        },
        effortPolicy: failover.effortPolicy,
        failoversMade: dispatch.failoversMade?.(step.id) ?? 0,
        quality: {
          policy: workflow?.quality_policy ?? "strict",
          step: qualityStepId(definition),
          steps: plan.qualityPlan?.packets[stepId]?.map((entry) => entry.id) ?? [stepId],
          round: dispatch.attempts.qualityHistory?.(step.id).round ?? 1,
        },
      },
    );
    if (
      result.ok &&
      result.outcome === "waiting_resource" &&
      result.reason === "RETRY_BUDGET_EXHAUSTED"
    )
      return { ok: false, reason: result.reason };
    return result;
  }
  if (step.status === "failed") {
    const retry = transitionStep(step.status, {
      type: "retry_authorized",
      reworkAllowsRetry: true,
    });
    if (!retry.ok) return { ok: false, reason: retry.reason };
    const committed = rework.session.commit({
      target: { kind: "step_run", id: step.id, expectedVersion: step.version, toStatus: retry.to },
      event: {
        eventId: dispatch.nextId(),
        kind: "step.retry_authorized",
        subject: step.id,
        runId,
        correlationId: latest.id,
        payload: "{}",
      },
    });
    if (!committed.ok) return { ok: false, reason: committed.reason };
  }
  return dispatchRunStep({ ...dispatch, canDispatch: canRetry }, { runId, stepId });
}
