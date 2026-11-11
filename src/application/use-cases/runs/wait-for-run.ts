import { z } from "zod";
import { identifierSchema } from "../../contracts/identifiers.js";
import type { RecoveryRunReader } from "../../ports/run-recovery.js";
import { inspectRun } from "./inspect-run.js";
import type { InspectRunResult, RunView } from "./inspect-run.js";

const waitSchema = z.strictObject({
  runId: identifierSchema,
  timeoutSeconds: z.number().int().min(1).max(3600),
});

export interface WaitForRunDependencies {
  readonly runs: RecoveryRunReader;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
}

export type WaitForRunResult =
  | { readonly ok: true; readonly run: RunView; readonly timedOut: boolean }
  | { readonly ok: false; readonly reason: "INVALID_INPUT" | "RUN_NOT_FOUND" };

/** Nothing is in flight: the run left `running`, or no step is running a worker. */
function settled(run: RunView): boolean {
  return run.status !== "running" || !run.steps.some((step) => step.status === "running");
}

/**
 * Long wait for the Coordinator, so it never polls across the Windows/WSL2 boundary. Returns as
 * soon as no worker is running (so a step that already finished does not make the caller wait
 * out the timeout), or with `timedOut: true` when the timeout passes first.
 */
export async function waitForRun(
  deps: WaitForRunDependencies,
  input: unknown,
): Promise<WaitForRunResult> {
  const parsed = waitSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const deadline = deps.now() + parsed.data.timeoutSeconds * 1000;
  for (;;) {
    const view: InspectRunResult = inspectRun(deps, { runId: parsed.data.runId });
    if (!view.ok) return view;
    if (settled(view.run)) return { ok: true, run: view.run, timedOut: false };
    if (deps.now() >= deadline) return { ok: true, run: view.run, timedOut: true };
    await deps.sleep(Math.min(deps.pollMs, Math.max(1, deadline - deps.now())));
  }
}
