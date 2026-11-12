import { z } from "zod";
import { modelsConfigSchema } from "../contracts/model-capability.js";
import { projectConfigSchema } from "../contracts/project-config.js";
import { contextPacketSchema } from "../contracts/context.js";
import { taskComplexitySchema } from "../contracts/task-complexity.js";
import type { DispatchPlanner, DispatchPlanRequest } from "../ports/dispatch-planner.js";
import type { ExecutorSelectionStore } from "../ports/executor-selection-store.js";
import {
  earliestQuotaReset,
  evaluateQuota,
  type QuotaReading,
  type QuotaThresholds,
  type QuotaVerdict,
} from "../../domain/profiles/quota-policy.js";
import type { ProfileRegistry } from "../ports/profile-registry.js";
import type { QuotaReader } from "../ports/quota-reader.js";
import type { RunPlanStore } from "../ports/run-plan-store.js";
import type { WorkflowCatalog } from "../ports/workflow-catalog.js";
import { selectExecutor } from "../use-cases/profiles/select-executor.js";
import { DispatchPlanningError } from "./dispatch-planning-error.js";

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
    taskId: z.string().regex(/^omi-\d{3,}$/),
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
    },
  ): Promise<Readonly<Record<string, unknown>>>;
} {
  const config = projectConfigSchema.parse(deps.config);
  const models = modelsConfigSchema.parse(deps.models);
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
  ) => {
    const plan = deps.plans.forRun(request.runId);
    const workflow =
      plan === undefined ? undefined : deps.workflows.byHash(plan.templateHash)?.workflow;
    const step = workflow?.steps.find((entry) => entry.id === request.stepId);
    if (step === undefined) throw new Error("WORKFLOW_UNKNOWN");
    const capability = models.capability_profiles[step.capability_profile];
    if (capability === undefined) throw new Error("CAPABILITY_UNKNOWN");
    // A required check without a command would silently fall back to the worker's word.
    const configured = config.checks ?? {};
    if (!step.required_checks.every((id) => Object.hasOwn(configured, id))) {
      throw new Error("CHECK_UNCONFIGURED");
    }
    return {
      models,
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
        capabilityProfile: { id: step.capability_profile, ...capability },
        expectedOutputSchema: step.output_contract,
      },
    };
  };
  /**
   * Reads quota before any attempt is reserved (readers are async, the reservation is one short
   * synchronous transaction). A reader that throws counts as no reading: a missing number never
   * stops a dispatch, and a limit hit mid-run still fails over.
   */
  const quotaVerdicts = async (
    requiredExecutor: string | undefined,
  ): Promise<ReadonlyMap<string, QuotaVerdict> | undefined> => {
    const policy = config.quota;
    const reader = deps.quota;
    if (policy === undefined || reader === undefined) return undefined;
    const thresholds: QuotaThresholds = {
      minFiveHourLeftPercent: policy.min_five_hour_left_percent,
      minSevenDayLeftPercent: policy.min_seven_day_left_percent,
      coordinatorSharedPenalty: policy.coordinator_shared_penalty,
      coordinatorSharedPolicy: policy.coordinator_shared_policy,
      staleAfterMs: policy.stale_after_minutes * 60_000,
    };
    const now = deps.now();
    const entries = await Promise.all(
      deps.profiles
        .list()
        .filter(
          ({ metadata }) => requiredExecutor === undefined || metadata.tool === requiredExecutor,
        )
        .map(async ({ metadata }) => {
          const ref = {
            profileId: metadata.profileId,
            tool: metadata.tool,
            credentialRef: metadata.credentialRef,
          };
          const read = (probe: boolean) =>
            reader.read(ref, { now, probe }).then(
              (result) => result.reading,
              () => null,
            );
          const evaluate = (reading: QuotaReading | null) =>
            evaluateQuota(
              {
                profileId: metadata.profileId,
                sharesCoordinatorAccount: policy.coordinator_shared_profiles.includes(
                  metadata.profileId,
                ),
                reading,
              },
              thresholds,
              now,
            );
          let reading = await read(false);
          let verdict = evaluate(reading);
          if (policy.probe_when_stale && verdict.freshness !== "fresh") {
            reading = (await read(true)) ?? reading;
            verdict = evaluate(reading);
          }
          return [metadata.profileId, verdict] as const;
        }),
    );
    return new Map(entries);
  };
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
        ),
        selectedExecutor: selection.candidate.executor,
      };
    },
    async plan(request) {
      const plan = deps.plans.forRun(request.runId);
      const workflow =
        plan === undefined ? undefined : deps.workflows.byHash(plan.templateHash)?.workflow;
      const step = workflow?.steps.find((entry) => entry.id === request.stepId);
      if (step === undefined) return undefined;
      const task = dispatchTaskSchema.parse(await deps.task(request.taskId));
      const verdicts = await quotaVerdicts(
        models.capability_profiles[step.capability_profile]?.required_executor,
      );
      const attemptId = deps.nextId();
      const selected = selectExecutor(deps.selections, {
        ...(verdicts === undefined ? {} : { quota: verdicts }),
        attemptId,
        stepRunId: request.stepRunId,
        attemptNumber: deps.nextAttemptNumber(request.stepRunId),
        capabilityProfile: step.capability_profile,
        now: deps.now(),
        models,
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
        );
      } catch (error) {
        deps.cancelReservation(attemptId);
        throw error;
      }
    },
  };
}
