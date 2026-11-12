import type { ReworkState } from "../../domain/runs/rework-policy.js";
import type { AgentAttemptStatus } from "../../domain/runs/agent-attempt.js";
import type { RunStatus } from "../../domain/runs/workflow-run.js";
import type { StepStatus } from "../../domain/runs/step-run.js";

/** The latest attempt of one step, as dispatched: who runs it and what it was given. */
export interface OverviewAttempt {
  readonly stepId: string;
  readonly attemptId: string;
  readonly status: AgentAttemptStatus;
  readonly executor: string;
  readonly profileId: string;
  readonly model: string;
  readonly effort?: string;
  readonly role?: string;
  /** Ids of the skills and rules the worker really received (the dispatch record's manifests). */
  readonly skills: readonly string[];
  readonly rules: readonly string[];
  readonly startedAt: string;
}

export interface RunOverview {
  readonly runId: string;
  readonly taskId: string;
  readonly issueNumber: number;
  readonly status: RunStatus;
  /** Pins the workflow template the run started with. */
  readonly templateHash: string;
  readonly rework: ReworkState;
  /** The newest iteration of each step, in the order the runtime created them. */
  readonly steps: readonly { readonly stepId: string; readonly status: StepStatus }[];
  /** The newest attempt of each step that has one. */
  readonly attempts: readonly OverviewAttempt[];
}

/** Read-only view of the runs that are not closed, from the runtime's durable state. */
export interface RunOverviewReader {
  listActive(): readonly RunOverview[];
}
