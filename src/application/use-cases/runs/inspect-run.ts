import { z } from "zod";
import type { RunStatus } from "../../../domain/runs/workflow-run.js";
import type { StepStatus } from "../../../domain/runs/step-run.js";
import { identifierSchema } from "../../contracts/identifiers.js";
import type { RecoveryRunReader } from "../../ports/run-recovery.js";

export interface RunView {
  readonly runId: string;
  readonly status: RunStatus;
  readonly steps: readonly {
    readonly stepRunId: string;
    readonly stepId: string;
    readonly status: StepStatus;
  }[];
}

export type InspectRunResult =
  | { readonly ok: true; readonly run: RunView }
  | { readonly ok: false; readonly reason: "INVALID_INPUT" | "RUN_NOT_FOUND" };

/** Read-only view of one run and its steps from durable state. */
export function inspectRun(
  deps: { readonly runs: RecoveryRunReader },
  input: unknown,
): InspectRunResult {
  const parsed = z.strictObject({ runId: identifierSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const run = deps.runs.get(parsed.data.runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  return {
    ok: true,
    run: {
      runId: run.id,
      status: run.status,
      steps: deps.runs
        .listSteps(run.id)
        .map((step) => ({ stepRunId: step.id, stepId: step.stepId, status: step.status })),
    },
  };
}
