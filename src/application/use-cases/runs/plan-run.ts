import { z } from "zod";
import { findDependencyCycle } from "../../../domain/shared/graph.js";
import { transitionRun } from "../../../domain/runs/workflow-run.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import { slugSchema } from "../../contracts/identifiers.js";
import type { PlannedStep, RunPlanStore } from "../../ports/run-plan-store.js";
import type { WorkflowCatalog } from "../../ports/workflow-catalog.js";
import type { DispatchTask } from "../../services/plan-step-dispatch.js";
import { planWorkflowQuality, taskQualityFacts } from "../../services/plan-workflow-quality.js";
import { DispatchPlanningError } from "../../services/dispatch-planning-error.js";

const planRunSchema = z.strictObject({
  issueNumber: z.number().int().positive(),
  workflowId: slugSchema.optional(),
});

export interface PlanRunDependencies {
  readonly qualityTask?: DispatchTask;
  readonly tasks: RunPlanStore;
  readonly workflows: WorkflowCatalog;
  /** Used when the command names no workflow; absent means the Coordinator must name one. */
  readonly defaultWorkflowId?: string;
  readonly now: () => number;
  readonly nextId: () => string;
}

export type PlanRunResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly taskId: string;
      readonly workflowId: string;
      readonly steps: readonly PlannedStep[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | "INVALID_INPUT"
        | "WORKFLOW_REQUIRED"
        | "WORKFLOW_UNKNOWN"
        | "WORKFLOW_CYCLIC"
        | "TASK_NOT_FOUND"
        | "ACTIVE_RUN_EXISTS"
        | "PROJECT_LOCK_LOST";
    };

/**
 * Starts a run of a pinned workflow template for one imported task: steps without dependencies
 * are ready, the rest wait for `advanceRun`. It does not dispatch anything and never reads the
 * Issue text. A second active run for the task is refused.
 */
export function planRun(deps: PlanRunDependencies, input: unknown): PlanRunResult {
  const parsed = planRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const workflowId = parsed.data.workflowId ?? deps.defaultWorkflowId;
  if (workflowId === undefined) return { ok: false, reason: "WORKFLOW_REQUIRED" };
  const pinned = deps.workflows.byId(workflowId);
  if (pinned === undefined) return { ok: false, reason: "WORKFLOW_UNKNOWN" };
  const task = deps.tasks.findTask(parsed.data.issueNumber);
  if (task === undefined) return { ok: false, reason: "TASK_NOT_FOUND" };

  const qualityPlan =
    deps.qualityTask === undefined
      ? undefined
      : planWorkflowQuality(
          pinned.workflow,
          taskQualityFacts(pinned.workflow, deps.qualityTask, "analyze", 1),
        );
  const workflow = qualityPlan?.workflow ?? pinned.workflow;
  const graph = new Map(workflow.steps.map((step) => [step.id, step.needs]));
  if (findDependencyCycle(graph) !== undefined) return { ok: false, reason: "WORKFLOW_CYCLIC" };

  const started = transitionRun("pending", {
    type: "start",
    templateHash: pinned.hash,
    otherActiveRunForTask: false,
  });
  if (!started.ok) return { ok: false, reason: "WORKFLOW_UNKNOWN" };
  const steps: PlannedStep[] = workflow.steps.map((step) => ({
    stepRunId: deps.nextId(),
    stepId: step.id,
    status:
      step.needs.length === 0 &&
      transitionStep("pending", { type: "dependencies_met", inputsValid: true, inScope: true }).ok
        ? "ready"
        : "pending",
  }));
  const runId = deps.nextId();
  const created = deps.tasks.createRun({
    ...(qualityPlan === undefined ? {} : { qualityPlan }),
    runId,
    taskId: task.taskId,
    templateHash: pinned.hash,
    steps,
    at: new Date(deps.now()).toISOString(),
    eventId: deps.nextId(),
  });
  if (!created.ok) return { ok: false, reason: created.reason };
  return { ok: true, runId, taskId: task.taskId, workflowId, steps };
}

/** Runtime entry reads the approved baseline; the synchronous core also supports offline planning. */
export async function planRunWithTask(
  deps: PlanRunDependencies & {
    readonly readTask: (taskId: string) => Promise<DispatchTask>;
  },
  input: unknown,
): Promise<PlanRunResult> {
  const parsed = planRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const task = deps.tasks.findTask(parsed.data.issueNumber);
  if (task === undefined) return { ok: false, reason: "TASK_NOT_FOUND" };
  try {
    return planRun({ ...deps, qualityTask: await deps.readTask(task.taskId) }, input);
  } catch (error) {
    // Planning stays available before analysis establishes the approved baseline; dispatch gates remain.
    if (
      error instanceof DispatchPlanningError &&
      [
        "BUSINESS_APPROVAL_REQUIRED",
        "BUSINESS_APPROVAL_STALE",
        "IMPLEMENTATION_MAP_EMPTY",
        "PLAN_KEY_REQUIRED",
      ].includes(error.reason)
    )
      return planRun(deps, input);
    throw error;
  }
}
