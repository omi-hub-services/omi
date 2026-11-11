import { z } from "zod";
import { findDependencyCycle } from "../../../domain/shared/graph.js";
import { transitionRun } from "../../../domain/runs/workflow-run.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import { slugSchema } from "../../contracts/identifiers.js";
import type { PlannedStep, RunPlanStore } from "../../ports/run-plan-store.js";
import type { WorkflowCatalog } from "../../ports/workflow-catalog.js";

const planRunSchema = z.strictObject({
  issueNumber: z.number().int().positive(),
  workflowId: slugSchema.optional(),
});

export interface PlanRunDependencies {
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

  const graph = new Map(pinned.workflow.steps.map((step) => [step.id, step.needs]));
  if (findDependencyCycle(graph) !== undefined) return { ok: false, reason: "WORKFLOW_CYCLIC" };

  const started = transitionRun("pending", {
    type: "start",
    templateHash: pinned.hash,
    otherActiveRunForTask: false,
  });
  if (!started.ok) return { ok: false, reason: "WORKFLOW_UNKNOWN" };
  const steps: PlannedStep[] = pinned.workflow.steps.map((step) => ({
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
