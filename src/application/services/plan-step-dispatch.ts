import { z } from "zod";
import { modelsConfigSchema } from "../contracts/model-capability.js";
import { projectConfigSchema } from "../contracts/project-config.js";
import { contextPacketSchema } from "../contracts/context.js";
import { taskComplexitySchema } from "../contracts/task-complexity.js";
import type { DispatchPlanner, DispatchPlanRequest } from "../ports/dispatch-planner.js";
import type { ExecutorSelectionStore } from "../ports/executor-selection-store.js";
import { WORKSPACE_ID_PATTERN } from "../../domain/tasks/plan-key.js";
import { earliestQuotaReset, type QuotaVerdict } from "../../domain/profiles/quota-policy.js";
import type { ProfileRegistry } from "../ports/profile-registry.js";
import type { QuotaReader } from "../ports/quota-reader.js";
import type { StepFindingStore } from "../ports/step-findings.js";
import type { RunPlanStore } from "../ports/run-plan-store.js";
import type { WorkflowCatalog } from "../ports/workflow-catalog.js";
import { selectExecutor } from "../use-cases/profiles/select-executor.js";
import { DispatchPlanningError } from "./dispatch-planning-error.js";
import { createQuotaVerdictReader } from "./read-quota-verdicts.js";
import { qualityStepId, packetModels } from "./plan-workflow-quality.js";

export const dispatchTaskSchema = z.strictObject({
  context: contextPacketSchema.pick({
    taskSnapshot: true,
    acceptanceCriteria: true,
    businessBaselineHash: true,
    inputArtifacts: true,
    previousFindings: true,
    allowedScope: true,
    approvalRefs: true,
  }),
  complexity: taskComplexitySchema,
  workspace: z.strictObject({
    taskId: z.string().regex(WORKSPACE_ID_PATTERN),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(100),
  }),
});
export type DispatchTask = z.infer<typeof dispatchTaskSchema>;

const QUOTA_ONLY = new Set(["QUOTA_BELOW_THRESHOLD", "MODEL_WEEKLY_QUOTA_BELOW_THRESHOLD"]);

/**
 * `earliest_reset=<ISO|unknown>` when quota is the only thing that stopped selection: every
 * rejected candidate failed on a quota rule alone. A cooldown, login or concurrency rejection
 * keeps the plain "not plannable" outcome, so a quota message never hides another cause.
 */
function quotaRefusal(
  rejections: readonly { candidateId: string; reasons: readonly string[] }[],
  verdicts: ReadonlyMap<string, QuotaVerdict> | undefined,
): string | undefined {
  if (verdicts === undefined || rejections.length === 0) return undefined;
  const quotaOnly = (reasons: readonly string[]) =>
    reasons.length > 0 &&
    reasons.every((reason) => QUOTA_ONLY.has(reason) || reason === "SHARES_COORDINATOR_ACCOUNT") &&
    reasons.some((reason) => QUOTA_ONLY.has(reason));
  if (!rejections.every(({ reasons }) => quotaOnly(reasons))) return undefined;
  const blocked = [...verdicts.values()].filter(
    (verdict) =>
      verdict.blocked.length > 0 &&
      rejections.some(({ candidateId }) => candidateId.startsWith(`${verdict.profileId}:`)),
  );
  const earliest = earliestQuotaReset(blocked);
  return `earliest_reset=${earliest === null ? "unknown" : new Date(earliest).toISOString()}`;
}

/** Trusted task/config readers supply data; the selector owns all profile/model/effort policy. */
export function createDispatchPlanner(deps: {
  /** Optional: without a reader (or a `quota` block in the config) selection ignores quota. */
  readonly quota?: QuotaReader;
  readonly config: z.infer<typeof projectConfigSchema>;
  readonly models: z.infer<typeof modelsConfigSchema>;
  readonly plans: RunPlanStore;
  readonly workflows: WorkflowCatalog;
  readonly profiles: ProfileRegistry;
  readonly selections: ExecutorSelectionStore;
  readonly task: (taskId: string) => Promise<DispatchTask>;
  /** Runtime-observed findings of the step's previous attempt, e.g. a failed required check. */
  readonly findings?: Pick<StepFindingStore, "recall">;
  readonly qualityRound?: (stepRunId: string) => number;
  readonly nextAttemptNumber: (stepRunId: string) => number;
  readonly cancelReservation: (attemptId: string) => void;
  readonly now: () => number;
  readonly nextId: () => string;
}): DispatchPlanner & {
  planReserved(
    request: DispatchPlanRequest,
    selection: {
      readonly attemptId: string;
      readonly profileHome: string;
      readonly candidate: { readonly model: string; readonly executor: string };
      readonly effort: string;
      readonly quality?: import("../contracts/context.js").ContextPacket["quality"];
    },
  ): Promise<Readonly<Record<string, unknown>>>;
} {
  const config = projectConfigSchema.parse(deps.config);
  const models = modelsConfigSchema.parse(deps.models);
  /** The run's own template: its quality plan, else the installed/archived one it pinned by hash. */
  const pinnedWorkflow = (plan: ReturnType<RunPlanStore["forRun"]>) => {
    if (plan === undefined) return undefined;
    if (plan.qualityPlan?.workflow !== undefined) return plan.qualityPlan.workflow;
    const pinned = deps.workflows.byHash(plan.templateHash);
    if (pinned === undefined)
      throw new DispatchPlanningError("TEMPLATE_UNAVAILABLE", `template_hash=${plan.templateHash}`);
    return pinned.workflow;
  };
  const input = (
    request: DispatchPlanRequest,
    selection: {
      attemptId: string;
      profileHome: string;
      model: string;
      effort: string;
      executor: string;
    },
    task: DispatchTask,
    round: number,
  ) => {
    const plan = deps.plans.forRun(request.runId);
    const workflow = pinnedWorkflow(plan);
    const step = workflow?.steps.find((entry) => entry.id === request.stepId);
    if (step === undefined) throw new Error("WORKFLOW_UNKNOWN");
    const packetSteps = plan?.qualityPlan?.packets[step.id] ?? [step];
    const selectedModels = packetModels(models, packetSteps, step.capability_profile);
    const capability = selectedModels.capability_profiles[step.capability_profile];
    if (capability === undefined) throw new Error("CAPABILITY_UNKNOWN");
    // A required check without a command would silently fall back to the worker's word.
    const configured = config.checks ?? {};
    if (!step.required_checks.every((id) => Object.hasOwn(configured, id))) {
      throw new Error("CHECK_UNCONFIGURED");
    }
    return {
      checkEvidenceSteps:
        qualityStepId(step) === "review"
          ? step.needs.filter((id) =>
              workflow?.steps.some(
                (candidate) => candidate.id === id && qualityStepId(candidate) === "verify",
              ),
            )
          : [],
      quality: {
        policy: workflow?.quality_policy ?? "strict",
        step: qualityStepId(step),
        steps: plan?.qualityPlan?.packets[step.id]?.map((s) => s.id) ?? [step.id],
        round,
      },
      models: selectedModels,
      packetSteps,
      task: {
        ...task.complexity,
        workflow: task.complexity.workflow ?? workflow?.id ?? null,
        acCount: task.context.acceptanceCriteria.length,
      },
      effortPolicy: config.effort_policy,
      reservedAttemptId: selection.attemptId,
      selectedExecutor: selection.executor,
      taskId: task.workspace.taskId,
      slug: task.workspace.slug,
      owner: deps.nextId(),
      role: step.role,
      stepSkills: step.skills,
      stepRules: step.rules,
      requiredChecks: step.required_checks,
      execution: {
        profileHome: selection.profileHome,
        model: selection.model,
        effort: selection.effort,
        access: "workspace-write",
        timeoutMs: config.limits.step_timeout_seconds * 1000,
      },
      context: {
        ...task.context,
        previousFindings: [
          ...task.context.previousFindings,
          ...(deps.findings?.recall(request.stepRunId) ?? []),
        ],
        capabilityProfile: { id: step.capability_profile, ...capability },
        expectedOutputSchema: step.output_contract,
      },
    };
  };
  /**
   * Reads quota before any attempt is reserved (readers are async, the reservation is one short
   * synchronous transaction). Without a `quota` block or a reader nothing is read and selection
   * ignores quota; a limit hit mid-run still fails over.
   */
  const quotaVerdicts: (
    requiredExecutor: string | undefined,
  ) => Promise<ReadonlyMap<string, QuotaVerdict> | undefined> =
    config.quota === undefined || deps.quota === undefined
      ? () => Promise.resolve(undefined)
      : createQuotaVerdictReader({
          policy: config.quota,
          reader: deps.quota,
          profiles: deps.profiles,
          now: deps.now,
          probe: true,
        });
  return {
    async planReserved(request, selection) {
      return {
        ...input(
          request,
          {
            attemptId: selection.attemptId,
            profileHome: selection.profileHome,
            model: selection.candidate.model,
            effort: selection.effort,
            executor: selection.candidate.executor,
          },
          dispatchTaskSchema.parse(await deps.task(request.taskId)),
          selection.quality?.round ?? deps.qualityRound?.(request.stepRunId) ?? 1,
        ),
        selectedExecutor: selection.candidate.executor,
      };
    },
    async plan(request) {
      const plan = deps.plans.forRun(request.runId);
      const workflow = pinnedWorkflow(plan);
      const step = workflow?.steps.find((entry) => entry.id === request.stepId);
      if (step === undefined) return undefined;
      const task = dispatchTaskSchema.parse(await deps.task(request.taskId));
      const selectedModels = packetModels(
        models,
        plan?.qualityPlan?.packets[step.id] ?? [step],
        step.capability_profile,
      );
      const verdicts = await quotaVerdicts(
        selectedModels.capability_profiles[step.capability_profile]?.required_executor,
      );
      const round =
        deps.qualityRound?.(request.stepRunId) ?? deps.nextAttemptNumber(request.stepRunId);
      const attemptId = deps.nextId();
      const selected = selectExecutor(deps.selections, {
        quality: {
          policy: workflow?.quality_policy ?? "strict",
          step: qualityStepId(step),
          steps: plan?.qualityPlan?.packets[step.id]?.map((s) => s.id) ?? [step.id],
          round,
        },
        ...(verdicts === undefined ? {} : { quota: verdicts }),
        attemptId,
        stepRunId: request.stepRunId,
        attemptNumber: deps.nextAttemptNumber(request.stepRunId),
        capabilityProfile: step.capability_profile,
        now: deps.now(),
        models: selectedModels,
        task: {
          ...task.complexity,
          workflow: task.complexity.workflow ?? workflow?.id ?? null,
          acCount: task.context.acceptanceCriteria.length,
        },
        effortPolicy: config.effort_policy,
      });
      if (selected.outcome !== "selected") {
        const refusal = quotaRefusal(selected.rejections, verdicts);
        if (refusal !== undefined) throw new DispatchPlanningError("QUOTA_EXHAUSTED", refusal);
        return undefined;
      }
      try {
        const profile = deps.profiles
          .list()
          .find((entry) => entry.metadata.profileId === selected.candidate.profileId);
        if (profile === undefined) throw new Error("PROFILE_UNKNOWN");
        return input(
          request,
          {
            attemptId,
            profileHome: profile.metadata.credentialRef,
            model: selected.candidate.model,
            effort: selected.effort,
            executor: selected.candidate.executor,
          },
          task,
          round,
        );
      } catch (error) {
        deps.cancelReservation(attemptId);
        throw error;
      }
    },
  };
}
