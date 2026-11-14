import type { Finding } from "../contracts/result.js";

/**
 * What the runtime itself learned from a step's last attempt (for example a failed required
 * check) and hands to that step's next attempt as `previousFindings`. Held by the runtime
 * process; a restart loses it and the retry then relies on the evidence artifact alone.
 */
export interface StepFindingStore {
  /** Replaces what is remembered for the step run; an empty list forgets it. */
  remember(stepRunId: string, findings: readonly Finding[]): void;
  recall(stepRunId: string): readonly Finding[];
}

export function createStepFindingStore(): StepFindingStore {
  const findings = new Map<string, readonly Finding[]>();
  return {
    remember: (stepRunId, entries) => {
      if (entries.length === 0) findings.delete(stepRunId);
      else findings.set(stepRunId, entries);
    },
    recall: (stepRunId) => findings.get(stepRunId) ?? [],
  };
}
