import { contextPacketSchema } from "../contracts/context.js";
import type { AttemptStore } from "../ports/attempt-store.js";
import type { GitWorkspace } from "../ports/git-workspace.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { RunPlanStore } from "../ports/run-plan-store.js";
import type { RecoveryRunReader } from "../ports/run-recovery.js";
import type { ReworkRunReader } from "../ports/rework-run-reader.js";
import type { DispatchTask } from "./plan-step-dispatch.js";
import type { WriteCheckpointInput } from "../use-cases/runs/write-checkpoint.js";

/** Context comes from a verified persisted packet after restart, or this session's planned input. */
export function snapshotRunContext(
  deps: {
    readonly runs: RecoveryRunReader;
    readonly rework: ReworkRunReader;
    readonly plans: RunPlanStore;
    readonly attempts: AttemptStore;
    readonly artifacts: ArtifactStore;
    readonly task: (taskId: string) => DispatchTask | undefined;
    readonly configHash: string;
    readonly workspaces: GitWorkspace;
    readonly now: () => number;
    readonly nextId: () => string;
  },
  runId: string,
  boundary?: {
    readonly stepRunId: string;
    readonly stepId: string;
    readonly workspacePath: string;
  },
): Omit<WriteCheckpointInput, "runId" | "kind"> {
  const plan = deps.plans.forRun(runId);
  if (plan === undefined) throw new Error("TASK_NOT_FOUND");
  const steps = deps.runs.listSteps(runId);
  const attempts = steps.flatMap((step) => {
    const attempt = deps.attempts.latestForStep(step.id);
    return attempt === undefined ? [] : [attempt];
  });
  const latest = attempts.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const packet =
    latest === undefined
      ? undefined
      : contextPacketSchema.parse(
          JSON.parse(new TextDecoder().decode(deps.artifacts.read(latest.contextPacket))),
        );
  const task = deps.task(plan.taskId);
  const context = task?.context ?? packet;
  if (context === undefined) throw new Error("CHECKPOINT_CONTEXT_UNAVAILABLE");
  if (latest === undefined && boundary === undefined) {
    const step = steps.find((entry) => entry.status === "ready") ?? steps[0];
    if (task === undefined || step === undefined) throw new Error("CHECKPOINT_CONTEXT_UNAVAILABLE");
    const at = deps.now();
    const workspace = deps.workspaces.createTask({
      ...task.workspace,
      owner: deps.nextId(),
      now: new Date(at).toISOString(),
      expiresAt: new Date(at + 60_000).toISOString(),
    });
    if (!workspace.ok) throw new Error(workspace.error.code);
    boundary = { stepRunId: step.id, stepId: step.stepId, workspacePath: workspace.value.path };
  }
  return {
    stepRunId: boundary?.stepRunId ?? latest?.stepRunId,
    stepId: boundary?.stepId ?? latest?.stepId,
    workspacePath: boundary?.workspacePath ?? latest?.workspace.path ?? "",
    hashes: { config: deps.configHash, template: plan.templateHash },
    taskSnapshot: context.taskSnapshot,
    acceptanceCriteria: context.acceptanceCriteria,
    businessBaselineHash: context.businessBaselineHash,
    approvalRefs: context.approvalRefs,
    counters: { failedCycles: deps.rework.get(runId)?.rework.failedCycles ?? 0 },
    nextAction: { action: "dispatch-step", stepId: boundary?.stepId ?? latest?.stepId },
  };
}
