import type { StepStatus } from "../../domain/runs/step-run.js";
import type { WorkflowQualityPlan } from "../contracts/workflow.js";

/** The task a run belongs to, as local state knows it (GitHub stays the source of task content). */
export interface RunTask {
  readonly taskId: string;
  readonly projectId: string;
  /** `owner/name` of the project's repository. */
  readonly repository: string;
  readonly issueNumber: number;
}

export interface PlannedStep {
  readonly stepRunId: string;
  /** Workflow step id (`step_runs.step_key`). */
  readonly stepId: string;
  /** `ready` for a step with no unmet dependency, otherwise `pending`. */
  readonly status: Extract<StepStatus, "ready" | "pending">;
}

export interface RunPlan {
  readonly qualityPlan?: WorkflowQualityPlan;
  readonly runId: string;
  readonly taskId: string;
  /** Pins the workflow template so a template update cannot change a running run. */
  readonly templateHash: string;
  readonly steps: readonly PlannedStep[];
  /** ISO-8601 UTC. */
  readonly at: string;
  readonly eventId: string;
}

export type CreateRunResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "ACTIVE_RUN_EXISTS" | "PROJECT_LOCK_LOST" };

export interface ReopenSteps {
  readonly runId: string;
  /** New iteration of each step; only steps whose newest iteration succeeded can be reopened. */
  readonly steps: readonly PlannedStep[];
  readonly at: string;
  readonly eventId: string;
  /** Head of the task branch after the refresh merge, recorded in the audit event. */
  readonly headSha: string;
}

export type ReopenStepsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "STEPS_NOT_FINISHED" | "PROJECT_LOCK_LOST" };

/**
 * Runtime-owned run rows. `createRun` inserts the run (already running), its steps and one audit
 * event in a single transaction; it refuses a second active run for the same task.
 */
export interface RunPlanStore {
  findTask(issueNumber: number): RunTask | undefined;
  /** The task and pinned template hash of a run. */
  forRun(
    runId: string,
  ):
    | (RunTask & { readonly templateHash: string; readonly qualityPlan?: WorkflowQualityPlan })
    | undefined;
  createRun(plan: RunPlan): CreateRunResult;
  /** One transaction: a new `iteration` row per step plus a `run.refreshed` audit event. */
  reopenSteps?(request: ReopenSteps): ReopenStepsResult;
}
