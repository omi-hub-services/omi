import { prepareRunPrSchema } from "../../contracts/pr-delivery.js";
import type { AttemptStore } from "../../ports/attempt-store.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import { DeliveryError } from "../../ports/pr-delivery.js";
import type { RunPlanStore } from "../../ports/run-plan-store.js";
import type { RecoveryRunReader } from "../../ports/run-recovery.js";
import { preparePr } from "./prepare-pr.js";
import type { PreparePrDeps, PreparePrResult } from "./prepare-pr.js";

export interface PrepareRunPrDependencies {
  readonly runs: RecoveryRunReader;
  readonly plans: Pick<RunPlanStore, "forRun">;
  readonly attempts: Pick<AttemptStore, "latestForStep">;
  readonly workspaces: Pick<GitWorkspace, "inspect">;
  readonly prepare: PreparePrDeps;
}

export type PrepareRunPrResult =
  ({ readonly ok: true } & PreparePrResult) | { readonly ok: false; readonly reason: string };

/** Resolve PR identities from runtime records; caller text supplies only title and AC evidence. */
export async function prepareRunPr(
  deps: PrepareRunPrDependencies,
  input: unknown,
): Promise<PrepareRunPrResult> {
  const parsed = prepareRunPrSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const { runId, title, evidence } = parsed.data;
  const run = deps.runs.get(runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  if (run.status !== "running" && run.status !== "succeeded")
    return { ok: false, reason: "RUN_NOT_DELIVERABLE" };
  const steps = deps.runs.listSteps(runId);
  if (!steps.every((step) => step.status === "succeeded"))
    return { ok: false, reason: "STEPS_NOT_SUCCEEDED" };
  const task = deps.plans.forRun(runId);
  if (task === undefined) return { ok: false, reason: "TASK_NOT_FOUND" };
  const attempts = steps.map((step) => deps.attempts.latestForStep(step.id));
  const workspace = attempts.find((attempt) => attempt !== undefined)?.workspace;
  if (workspace === undefined) return { ok: false, reason: "WORKSPACE_UNAVAILABLE" };
  if (
    attempts.some(
      (attempt) =>
        attempt === undefined ||
        attempt.runId !== runId ||
        attempt.workspace.path !== workspace.path ||
        attempt.workspace.branch !== workspace.branch,
    )
  )
    return { ok: false, reason: "WORKSPACE_MISMATCH" };
  const inspected = deps.workspaces.inspect(workspace.path);
  if (!inspected.ok) return { ok: false, reason: "WORKSPACE_UNAVAILABLE" };
  if (inspected.value.branch !== workspace.branch)
    return { ok: false, reason: "WORKSPACE_MISMATCH" };
  try {
    return {
      ok: true,
      ...(await preparePr(deps.prepare, {
        projectId: task.projectId,
        taskId: task.taskId,
        repository: task.repository,
        issueNumber: task.issueNumber,
        head: workspace.branch,
        title,
        evidence,
      })),
    };
  } catch (error) {
    if (!(error instanceof DeliveryError)) throw error;
    return { ok: false, reason: error.code };
  }
}
