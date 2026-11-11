import type { SelectionResult } from "../../domain/agents/selection-policy.js";
import type { RegisteredProfile } from "../../domain/profiles/profile-metadata.js";
import type { AttemptSettings } from "../../domain/runs/agent-attempt.js";
import type { ExecutionResult } from "../contracts/agent-execution.js";

export interface ExecutorSelectionStore {
  /**
   * Snapshot, choose, insert pending attempt in one short transaction. The step must already
   * exist. Counts pending reservations as occupied; attempt IDs are immutable, never reused.
   */
  reserve(
    attempt: {
      readonly id: string;
      readonly stepRunId: string;
      readonly number: number;
      readonly at: number;
    },
    choose: (profiles: readonly RegisteredProfile[]) => SelectionResult,
  ): SelectionResult;
  /** Saves only CLI-reported model/effort, after checking attempt and requested settings. */
  recordResult(attemptId: string, result: ExecutionResult): void;
  settings(attemptId: string): AttemptSettings | undefined;
}
