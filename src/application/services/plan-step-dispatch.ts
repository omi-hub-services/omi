import { z } from "zod";
import { modelsConfigSchema } from "../contracts/model-capability.js";
import { projectConfigSchema } from "../contracts/project-config.js";
import { contextPacketSchema } from "../contracts/context.js";
import { taskComplexitySchema } from "../contracts/task-complexity.js";
import type { DispatchPlanner, DispatchPlanRequest } from "../ports/dispatch-planner.js";
import type { ExecutorSelectionStore } from "../ports/executor-selection-store.js";
import type { ProfileRegistry } from "../ports/profile-registry.js";
import type { RunPlanStore } from "../ports/run-plan-store.js";
import type { WorkflowCatalog } from "../ports/workflow-catalog.js";
import { selectExecutor } from "../use-cases/profiles/select-executor.js";

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

/** Trusted task/config readers supply data; the selector owns all profile/model/effort policy. */
export function createDispatchPlanner(deps: {
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
      const attemptId = deps.nextId();
      const selected = selectExecutor(deps.selections, {
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
      if (selected.outcome !== "selected") return undefined;
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
