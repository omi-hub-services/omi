import { z } from "zod";
import { transitionStep } from "../../../domain/runs/step-run.js";
import { identifierSchema } from "../../contracts/identifiers.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type { RunPlanStore } from "../../ports/run-plan-store.js";
import type { RecoveryRunReader } from "../../ports/run-recovery.js";
import type { WorkflowCatalog } from "../../ports/workflow-catalog.js";

export interface AdvanceRunDependencies {
  readonly runs: RecoveryRunReader;
  readonly plans: Pick<RunPlanStore, "forRun">;
  readonly workflows: WorkflowCatalog;
  readonly session: Pick<ProjectSession, "commit">;
  readonly nextId: () => string;
}

export type AdvanceRunResult =
  | { readonly ok: true; readonly ready: readonly string[] }
  | {
      readonly ok: false;
      readonly reason:
        | "INVALID_INPUT"
        | "RUN_NOT_FOUND"
        | "RUN_NOT_RUNNING"
        | "WORKFLOW_UNKNOWN"
        | "STATE_REJECTED";
    };

/**
 * Makes every pending step ready whose dependencies in the pinned template have all succeeded.
 * It never dispatches, never completes the run (that needs the merge gate, see `deliverRun`) and
 * never retries a failed step (the rework controller owns that).
 */
export function advanceRun(deps: AdvanceRunDependencies, input: unknown): AdvanceRunResult {
  const parsed = z.strictObject({ runId: identifierSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const run = deps.runs.get(parsed.data.runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  if (run.status !== "running") return { ok: false, reason: "RUN_NOT_RUNNING" };
  const pinned = deps.plans.forRun(run.id);
  const workflow = pinned === undefined ? undefined : deps.workflows.byHash(pinned.templateHash);
  if (workflow === undefined) return { ok: false, reason: "WORKFLOW_UNKNOWN" };

  const steps = deps.runs.listSteps(run.id);
  const succeeded = new Set(
    steps.filter((step) => step.status === "succeeded").map((step) => step.stepId),
  );
  const ready: string[] = [];
  for (const step of steps) {
    if (step.status !== "pending") continue;
    const needs = workflow.workflow.steps.find((candidate) => candidate.id === step.stepId)?.needs;
    if (needs === undefined || !needs.every((need) => succeeded.has(need))) continue;
    const moved = transitionStep(step.status, {
      type: "dependencies_met",
      inputsValid: true,
      inScope: true,
    });
    if (!moved.ok) continue;
    const committed = deps.session.commit({
      target: {
        kind: "step_run",
        id: step.id,
        expectedVersion: step.version,
        toStatus: moved.to,
      },
      event: {
        eventId: deps.nextId(),
        kind: "step.ready",
        subject: step.id,
        runId: run.id,
        correlationId: run.id,
        payload: JSON.stringify({ stepId: step.stepId }),
      },
    });
    if (!committed.ok) return { ok: false, reason: "STATE_REJECTED" };
    ready.push(step.stepId);
  }
  return { ok: true, ready };
}
