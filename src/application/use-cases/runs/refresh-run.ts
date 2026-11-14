import { refreshRunSchema } from "../../contracts/run-refresh.js";
import type { AttemptStore } from "../../ports/attempt-store.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import type { PlannedStep, RunPlanStore } from "../../ports/run-plan-store.js";
import type { RecoveryRunReader } from "../../ports/run-recovery.js";
import type { WorkflowCatalog } from "../../ports/workflow-catalog.js";
import { qualityStepId } from "../../services/plan-workflow-quality.js";

export interface RefreshRunDependencies {
  readonly runs: RecoveryRunReader;
  readonly plans: Pick<RunPlanStore, "forRun" | "reopenSteps">;
  readonly workflows: WorkflowCatalog;
  readonly attempts: Pick<AttemptStore, "latestForStep" | "qualityHistory">;
  readonly workspaces: Pick<
    GitWorkspace,
    "inspect" | "developHead" | "mergeDevelop" | "acquireWriter" | "releaseWriter"
  >;
  readonly now: () => number;
  readonly nextId: () => string;
}

export type RefreshRunResult =
  | {
      readonly ok: true;
      readonly headSha: string;
      /** Workflow step ids reopened as a new iteration. */
      readonly reopened: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

/**
 * A finished run whose review no longer matches `develop` cannot be delivered (the merge gate
 * stays as it is) and `retry` only takes failed steps. Refresh merges `origin/develop` into the
 * task branch under the writer lease (no hooks, no push) and reopens verify and review as a new
 * iteration. Implement does not rerun; the delta review starts from the previous verdict. A
 * refresh is not a failure, so the rework counters never see it.
 */
export function refreshRun(deps: RefreshRunDependencies, input: unknown): RefreshRunResult {
  const parsed = refreshRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const { runId } = parsed.data;
  const run = deps.runs.get(runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  if (run.status !== "running") return { ok: false, reason: "RUN_NOT_RUNNING" };
  const steps = deps.runs.listSteps(runId);
  if (steps.length === 0 || !steps.every((step) => step.status === "succeeded"))
    return { ok: false, reason: "RUN_NOT_FINISHED" };
  const plan = deps.plans.forRun(runId);
  if (plan === undefined) return { ok: false, reason: "TASK_NOT_FOUND" };
  const workflow = (
    plan.qualityPlan?.workflow ?? deps.workflows.byHash(plan.templateHash)?.workflow
  )?.steps;
  if (workflow === undefined) return { ok: false, reason: "WORKFLOW_UNKNOWN" };
  const quality = workflow.filter((step) => ["verify", "review"].includes(qualityStepId(step)));
  const review = quality.find((step) => qualityStepId(step) === "review");
  const reviewRun = steps.find((step) => step.stepId === review?.id);
  if (reviewRun === undefined || deps.plans.reopenSteps === undefined)
    return { ok: false, reason: "NOT_REFRESHABLE" };
  const reviewedBase = deps.attempts.qualityHistory?.(reviewRun.id).previousVerdict?.revision
    ?.baseSha;
  const workspace = deps.attempts.latestForStep(reviewRun.id)?.workspace;
  if (reviewedBase === undefined) return { ok: false, reason: "REVIEW_REVISION_MISSING" };
  if (workspace === undefined) return { ok: false, reason: "WORKSPACE_UNAVAILABLE" };

  const state = deps.workspaces.inspect(workspace.path);
  if (!state.ok) return { ok: false, reason: "WORKSPACE_UNAVAILABLE", detail: state.error.code };
  if (state.value.branch !== workspace.branch) return { ok: false, reason: "WORKSPACE_MISMATCH" };
  const develop = deps.workspaces.developHead?.(workspace.path);
  if (develop === undefined || !develop.ok)
    return {
      ok: false,
      reason: "DEVELOP_UNAVAILABLE",
      ...(develop === undefined ? {} : { detail: develop.error.code }),
    };
  if (develop.value === reviewedBase) return { ok: false, reason: "REVIEW_CURRENT" };

  const at = deps.now();
  const owner = deps.nextId();
  const lease = deps.workspaces.acquireWriter({
    taskId: workspace.taskId,
    slug: workspace.slug,
    owner,
    now: new Date(at).toISOString(),
    expiresAt: new Date(at + 120_000).toISOString(),
  });
  if (!lease.ok) return { ok: false, reason: lease.error.code };
  let merged: ReturnType<NonNullable<GitWorkspace["mergeDevelop"]>> | undefined;
  try {
    merged = deps.workspaces.mergeDevelop?.(workspace.path);
  } finally {
    deps.workspaces.releaseWriter({
      taskId: workspace.taskId,
      slug: workspace.slug,
      owner,
      generation: lease.value.generation,
      now: new Date(deps.now()).toISOString(),
    });
  }
  if (merged === undefined) return { ok: false, reason: "NOT_REFRESHABLE" };
  if (!merged.ok)
    return merged.error.code === "MERGE_CONFLICT"
      ? { ok: false, reason: "REFRESH_CONFLICT" }
      : { ok: false, reason: "REFRESH_FAILED", detail: merged.error.code };

  const reopened = new Set(quality.map((step) => step.id));
  const reopenedSteps: PlannedStep[] = quality.map((step) => ({
    stepRunId: deps.nextId(),
    stepId: step.id,
    // A step waiting on another reopened step is made ready by advanceRun once that one succeeds.
    status: step.needs.some((need) => reopened.has(need)) ? "pending" : "ready",
  }));
  const result = deps.plans.reopenSteps({
    runId,
    steps: reopenedSteps,
    at: new Date(deps.now()).toISOString(),
    eventId: deps.nextId(),
    headSha: merged.value.headSha,
  });
  if (!result.ok) return { ok: false, reason: "STATE_REJECTED", detail: result.reason };
  return { ok: true, headSha: merged.value.headSha, reopened: quality.map((step) => step.id) };
}
