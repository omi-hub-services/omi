import { stepResultSchema } from "../contracts/result.js";
import type { ExecutionHandle } from "../contracts/agent-execution.js";
import type { DispatchStepDependencies } from "../use-cases/runs/dispatch-step.js";
import type { AdvanceRunDependencies } from "../use-cases/runs/advance-run.js";
import { advanceRun } from "../use-cases/runs/advance-run.js";
import { recordStepResult } from "../use-cases/runs/record-step-result.js";
import {
  failoverStep,
  type FailoverStepDependencies,
} from "../use-cases/profiles/failover-step.js";
import {
  recordReworkEvent,
  type RecordReworkEventDependencies,
} from "../use-cases/runs/record-rework-event.js";
import type { ExecutorSelectionStore } from "../ports/executor-selection-store.js";
import { transitionStep } from "../../domain/runs/step-run.js";

export interface CompletionRouting {
  readonly failover?: FailoverStepDependencies;
  readonly rework?: RecordReworkEventDependencies;
  readonly selections?: ExecutorSelectionStore;
  readonly failoversMade?: (stepRunId: string) => number;
}

/** A limit is operational and must reach failover BEFORE generic result recording fails a step. */
export async function completeRunAttempt(
  deps: DispatchStepDependencies & AdvanceRunDependencies & CompletionRouting,
  attemptId: string,
  handle: ExecutionHandle,
  runId: string,
  request: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    const execution = await deps.executor.collectResult(handle);
    deps.selections?.recordResult(attemptId, execution);
    // Pause/owner shutdown reconciles the stopped writer through quiesceRunWorkers. A cancelled
    // process is not a quality failure and must remain recoverable from its boundary checkpoint.
    if (execution.outcome === "cancelled") return;
    const attempt = deps.attempts.get(attemptId);
    if (attempt === undefined) throw new Error("ATTEMPT_NOT_FOUND");
    if (execution.outcome === "usage-limit" && deps.failover !== undefined) {
      const plan = deps.plans.forRun(runId);
      const step =
        plan === undefined
          ? undefined
          : deps.workflows
              .byHash(plan.templateHash)
              ?.workflow.steps.find((entry) => entry.id === attempt.stepId);
      if (step === undefined) throw new Error("WORKFLOW_UNKNOWN");
      const result = await failoverStep(deps.failover, {
        runId,
        stepRunId: attempt.stepRunId,
        capabilityProfile: step.capability_profile,
        models: request["models"],
        task: request["task"],
        effortPolicy: request["effortPolicy"],
        execution,
        failoversMade: deps.failoversMade?.(attempt.stepRunId) ?? 0,
      });
      if (!result.ok) throw new Error(result.reason);
      return;
    }
    let report: unknown;
    try {
      report =
        execution.finalMessage === undefined
          ? undefined
          : (JSON.parse(execution.finalMessage) as unknown);
    } catch {
      report = undefined;
    }
    const recorded = recordStepResult(deps, { attemptId, execution, result: report });
    if (!recorded.ok) return;
    const reported = stepResultSchema.safeParse(report);
    if (
      !(reported.success && reported.data.status === "blocked") &&
      recorded.stepStatus === "failed" &&
      execution.outcome === "succeeded" &&
      deps.rework !== undefined
    ) {
      const result = recordReworkEvent(deps.rework, {
        runId,
        event: { type: "cycle_failed", cycleId: attempt.id, kind: "quality" },
      });
      if (!result.ok) throw new Error(result.reason);
      if (result.action === "retry") {
        const step = deps.steps.get(attempt.stepRunId);
        if (step === undefined) throw new Error("STEP_NOT_FOUND");
        const retry = transitionStep(step.status, {
          type: "retry_authorized",
          reworkAllowsRetry: true,
        });
        if (!retry.ok) throw new Error(retry.reason);
        deps.session.commit({
          target: {
            kind: "step_run",
            id: step.id,
            expectedVersion: step.version,
            toStatus: retry.to,
          },
          event: {
            eventId: deps.nextId(),
            kind: "step.retry_authorized",
            subject: step.id,
            runId,
            correlationId: attempt.id,
            payload: "{}",
          },
        });
      }
    }
    advanceRun(deps, { runId });
  } catch {
    // Keep durable state for recovery; never convert a completion exception into success.
    try {
      deps.session.commit({
        target: { kind: "session_event" },
        event: {
          eventId: deps.nextId(),
          kind: "attempt.completion_refused",
          subject: attemptId,
          runId,
          correlationId: attemptId,
          payload: "{}",
        },
      });
    } catch {
      /* A lost session cannot append audit; recovery retains its durable state. */
    }
  }
}
