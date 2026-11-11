import type { StepStatus } from "../../domain/runs/step-run.js";

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
  { readonly ok: true } | { readonly ok: false; readonly reason: "ACTIVE_RUN_EXISTS" };

/**
 * Runtime-owned run rows. `createRun` inserts the run (already running), its steps and one audit
 * event in a single transaction; it refuses a second active run for the same task.
 */
export interface RunPlanStore {
  findTask(issueNumber: number): RunTask | undefined;
  /** The task and pinned template hash of a run. */
  forRun(runId: string): (RunTask & { readonly templateHash: string }) | undefined;
  createRun(plan: RunPlan): CreateRunResult;
}
