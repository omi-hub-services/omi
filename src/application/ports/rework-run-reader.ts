import type { ReworkState } from "../../domain/runs/rework-policy.js";
import type { RunStatus } from "../../domain/runs/workflow-run.js";

export interface ReworkRun {
  readonly id: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly version: number;
  readonly rework: ReworkState;
}

/** Read the live run, never a transcript or checkpoint copy of the counter. */
export interface ReworkRunReader {
  get(runId: string): ReworkRun | undefined;
}
