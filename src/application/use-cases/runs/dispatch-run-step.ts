import { z } from "zod";
import { identifierSchema, slugSchema } from "../../contracts/identifiers.js";
import { executorSchema } from "../../contracts/model-capability.js";
import type { AgentExecutor } from "../../ports/agent-executor.js";
import { completeRunAttempt, type CompletionRouting } from "../../services/complete-run-attempt.js";
import {
  DispatchPlanningError,
  type DispatchPlanningRefusal,
} from "../../services/resolve-dispatch-task.js";
import type { DispatchPlanner } from "../../ports/dispatch-planner.js";
import type { RecoveryRunReader } from "../../ports/run-recovery.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import type { AdvanceRunDependencies } from "./advance-run.js";
import { dispatchStep } from "./dispatch-step.js";
import type { DispatchRefusal, DispatchStepDependencies } from "./dispatch-step.js";

const dispatchRunStepSchema = z.strictObject({ runId: identifierSchema, stepId: slugSchema });

export interface DispatchRunStepDependencies
  extends DispatchStepDependencies, CompletionRouting, Omit<AdvanceRunDependencies, "nextId"> {
  readonly runs: RecoveryRunReader;
  readonly executors?: Readonly<Record<"claude-code" | "codex", AgentExecutor>>;
  readonly planner: DispatchPlanner;
  readonly canDispatch?: () => boolean;
  /**
   * Called with the promise that finishes the attempt (collect, verify, record, advance). The
   * runtime keeps it so it can wait for it on shutdown; it never rejects.
   */
  readonly track: (completion: Promise<void>) => void;
}

export type DispatchRunStepResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly stepRunId: string;
      readonly attemptId: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | DispatchRefusal
        | DispatchPlanningRefusal
        | "RUN_NOT_FOUND"
        | "RUN_NOT_RUNNING"
        | "NOT_PLANNABLE";
      readonly detail?: string;
    };

/**
 * Dispatches one ready or resource-waiting step: the planner supplies the trusted input, then
 * `dispatchStep` allocates the attempt and starts the worker. When the worker finishes, its final
 * message is verified by `recordStepResult` and `advanceRun` readies the next steps. A process
 * that ends without a valid result fails the step; this use case never treats exit 0 as success.
 */
export async function dispatchRunStep(
  deps: DispatchRunStepDependencies,
  input: unknown,
): Promise<DispatchRunStepResult> {
  const parsed = dispatchRunStepSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const run = deps.runs.get(parsed.data.runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  if (run.status !== "running") return { ok: false, reason: "RUN_NOT_RUNNING" };
  const step = deps.runs
    .listSteps(run.id)
    .find(
      (candidate) =>
        candidate.stepId === parsed.data.stepId &&
        (candidate.status === "ready" || candidate.status === "waiting_resource"),
    );
  if (step === undefined) return { ok: false, reason: "STEP_NOT_READY" };

  let request: Readonly<Record<string, unknown>> | undefined;
  try {
    request = await deps.planner.plan({
      runId: run.id,
      stepRunId: step.id,
      stepId: step.stepId,
      taskId: deps.plans.forRun(run.id)?.taskId ?? "",
    });
  } catch (error) {
    if (error instanceof DispatchPlanningError) return { ok: false, reason: error.reason };
    throw error;
  }
  if (request === undefined) return { ok: false, reason: "NOT_PLANNABLE" };

  try {
    if (deps.runs.get(run.id)?.status !== "running" || deps.canDispatch?.() === false) {
      releaseReservation(deps, request);
      return { ok: false, reason: "RUN_NOT_RUNNING" };
    }
    const current = deps.steps.get(step.id);
    if (current?.version !== step.version || current.status !== step.status) {
      releaseReservation(deps, request);
      return { ok: false, reason: "STEP_NOT_READY" };
    }
    if (current.status === "waiting_resource") {
      const available = transitionStep(current.status, {
        type: "resource_available",
        candidateAvailable: true,
      });
      if (!available.ok) {
        releaseReservation(deps, request);
        return { ok: false, reason: "STEP_NOT_READY" };
      }
      const committed = deps.session.commit({
        target: {
          kind: "step_run",
          id: step.id,
          expectedVersion: current.version,
          toStatus: available.to,
        },
        event: {
          eventId: deps.nextId(),
          kind: "step.resource_available",
          subject: step.id,
          runId: run.id,
          correlationId:
            typeof request["reservedAttemptId"] === "string"
              ? request["reservedAttemptId"]
              : run.id,
          payload: "{}",
        },
      });
      if (!committed.ok) {
        releaseReservation(deps, request);
        return { ok: false, reason: "STATE_REJECTED", detail: committed.reason };
      }
    }
  } catch (error) {
    releaseReservation(deps, request);
    throw error;
  }

  return dispatchPlannedRunStep(deps, request, step.id, run.id);
}

/** Also used by checkpoint failover, which already owns a selector reservation. */
export async function dispatchPlannedRunStep(
  deps: DispatchRunStepDependencies,
  request: Readonly<Record<string, unknown>>,
  stepRunId: string,
  runId: string,
): Promise<DispatchRunStepResult> {
  const executor =
    request["selectedExecutor"] === undefined
      ? deps.executor
      : (deps.executors?.[executorSchema.parse(request["selectedExecutor"])] ?? deps.executor);
  const bound = { ...deps, executor };
  let dispatched: Awaited<ReturnType<typeof dispatchStep>>;
  try {
    dispatched = await dispatchStep(bound, { ...request, stepRunId });
  } catch (error) {
    // dispatchStep releases its writer lease before propagating an unexpected failure.
    releaseReservation(deps, request);
    throw error;
  }
  if (!dispatched.ok) {
    releaseReservation(deps, request);
    return {
      ok: false,
      reason: dispatched.reason,
      ...(dispatched.detail === undefined ? {} : { detail: dispatched.detail }),
    };
  }
  deps.track(completeRunAttempt(bound, dispatched.attempt.id, dispatched.handle, runId, request));
  return { ok: true, runId, stepRunId, attemptId: dispatched.attempt.id };
}

function releaseReservation(
  deps: DispatchStepDependencies,
  request: Readonly<Record<string, unknown>>,
): void {
  if (typeof request["reservedAttemptId"] === "string") {
    const attempt = deps.attempts.get(request["reservedAttemptId"]);
    if (attempt === undefined || attempt.status === "pending")
      deps.attempts.setStatus(request["reservedAttemptId"], "cancelled");
  }
}
