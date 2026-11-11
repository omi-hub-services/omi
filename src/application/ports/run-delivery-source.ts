import type { AttemptRecord } from "./attempt-store.js";
import type { StepResult } from "../contracts/result.js";

/** Accepted results and durable workflow gates, without inferred review policy. */
export interface RunDeliverySource {
  read(
    projectId: string,
    taskId: string,
  ): {
    readonly entries: readonly { readonly attempt: AttemptRecord; readonly result: StepResult }[];
    readonly allStepsSucceeded: boolean;
  };
}
