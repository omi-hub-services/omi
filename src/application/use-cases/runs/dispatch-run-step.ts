import { z } from "zod";
import { identifierSchema, slugSchema } from "../../contracts/identifiers.js";
import type { ExecutionHandle } from "../../contracts/agent-execution.js";
import type { DispatchPlanner } from "../../ports/dispatch-planner.js";
import type { RecoveryRunReader } from "../../ports/run-recovery.js";
import { advanceRun } from "./advance-run.js";
import type { AdvanceRunDependencies } from "./advance-run.js";
import { dispatchStep } from "./dispatch-step.js";
import type { DispatchRefusal, DispatchStepDependencies } from "./dispatch-step.js";
import { recordStepResult } from "./record-step-result.js";

const dispatchRunStepSchema = z.strictObject({ runId: identifierSchema, stepId: slugSchema });

export interface DispatchRunStepDependencies
  extends DispatchStepDependencies, Omit<AdvanceRunDependencies, "nextId"> {
  readonly runs: RecoveryRunReader;
  readonly planner: DispatchPlanner;
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
      readonly reason: DispatchRefusal | "RUN_NOT_FOUND" | "RUN_NOT_RUNNING" | "NOT_PLANNABLE";
      readonly detail?: string;
    };

/**
 * Dispatches one ready step of a run: the planner supplies the trusted dispatch input, then
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
    .find((candidate) => candidate.stepId === parsed.data.stepId && candidate.status === "ready");
  if (step === undefined) return { ok: false, reason: "STEP_NOT_READY" };

  const request = await deps.planner.plan({
    runId: run.id,
    stepRunId: step.id,
    stepId: step.stepId,
    taskId: deps.plans.forRun(run.id)?.taskId ?? "",
  });
  if (request === undefined) return { ok: false, reason: "NOT_PLANNABLE" };

  const dispatched = await dispatchStep(deps, { ...request, stepRunId: step.id });
  if (!dispatched.ok) {
    return {
      ok: false,
      reason: dispatched.reason,
      ...(dispatched.detail === undefined ? {} : { detail: dispatched.detail }),
    };
  }
  deps.track(finishAttempt(deps, dispatched.attempt.id, dispatched.handle, run.id));
  return { ok: true, runId: run.id, stepRunId: step.id, attemptId: dispatched.attempt.id };
}

async function finishAttempt(
  deps: DispatchRunStepDependencies,
  attemptId: string,
  handle: ExecutionHandle,
  runId: string,
): Promise<void> {
  try {
    const execution = await deps.executor.collectResult(handle);
    recordStepResult(deps, { attemptId, execution, result: parseFinalMessage(execution) });
    advanceRun({ ...deps, nextId: deps.nextId }, { runId });
  } catch {
    // The attempt stays running; resume/recovery reconciles it. The completion never rejects.
  }
}

function parseFinalMessage(execution: { readonly finalMessage?: string | undefined }): unknown {
  if (execution.finalMessage === undefined) return undefined;
  try {
    return JSON.parse(execution.finalMessage) as unknown;
  } catch {
    return undefined;
  }
}
