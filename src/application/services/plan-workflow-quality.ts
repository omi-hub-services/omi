import { inferComplexity } from "../../domain/agents/complexity-policy.js";
import {
  resolveQualityPolicy,
  workflowRisks,
  type QualityPolicyInput,
} from "../../domain/workflows/workflow-policy.js";
import type { Workflow, WorkflowQualityPlan } from "../contracts/workflow.js";
import type { TaskComplexity } from "../contracts/task-complexity.js";
import type { ContextPacket } from "../contracts/context.js";
import type { ModelsConfig } from "../contracts/model-capability.js";
import { effortRank } from "../../domain/agents/capability.js";

/** A resolved execution graph retains every gate and every original packet's skills/rules. */
export function planWorkflowQuality(
  workflow: Workflow,
  facts: QualityPolicyInput,
): WorkflowQualityPlan {
  const decision = resolveQualityPolicy({ ...facts, qualityPolicy: workflow.quality_policy });
  const verify = workflow.steps.find((s) => s.id === "verify");
  const review = workflow.steps.find((s) => s.role === "reviewer");
  const combine =
    decision.combineVerifyReview &&
    verify !== undefined &&
    review !== undefined &&
    review.needs.length === 1 &&
    review.needs[0] === verify.id &&
    !workflow.gates.some(
      (g) => g.before === verify.id || g.after === verify.id || g.before === review.id,
    ) &&
    !workflow.steps.some((s) => s.id !== review.id && s.needs.includes(verify.id));
  const skipAnalyze =
    decision.skipAnalyze &&
    !workflow.gates.some((g) => g.before === "analyze" || g.after === "analyze");
  const analysisNeeds = workflow.steps.find((s) => s.id === "analyze")?.needs ?? [];
  const packets: Record<string, Workflow["steps"]> = {};
  const steps = workflow.steps
    .filter((s) => !(skipAnalyze && s.id === "analyze") && !(combine && s.id === "verify"))
    .map((s) => {
      const originals = combine && s.id === review.id ? [verify, s] : [s];
      packets[s.id] = originals;
      return {
        ...s,
        needs: [
          ...new Set(
            (combine && s.id === review.id ? verify.needs : s.needs).flatMap((n) =>
              skipAnalyze && n === "analyze" ? analysisNeeds : [n],
            ),
          ),
        ],
        skills: [...new Set(originals.flatMap((o) => o.skills))],
        rules: [...new Set(originals.flatMap((o) => o.rules))],
        required_checks: [...new Set(originals.flatMap((o) => o.required_checks))],
      };
    });
  return {
    workflow: { ...workflow, steps },
    packets,
    ...(skipAnalyze && decision.scopeEvidence !== undefined
      ? { scopeEvidence: decision.scopeEvidence }
      : {}),
  };
}

/** Step ids stay project-owned; effort follows responsibility, including docs/accept. */
export function qualityStepId(step: Pick<Workflow["steps"][number], "id" | "role">): string {
  return step.role === "reviewer"
    ? "review"
    : step.role === "qa"
      ? "verify"
      : step.role === "analyst"
        ? "analyze"
        : step.id;
}

/** A combined worker qualifies for every constituent step, never just the review profile. */
export function packetModels(
  models: ModelsConfig,
  steps: readonly Workflow["steps"][number][],
  primary: string,
): ModelsConfig {
  if (steps.length < 2) return models;
  const profiles = steps.map((s) => models.capability_profiles[s.capability_profile]);
  const first = models.capability_profiles[primary];
  if (first === undefined || profiles.some((p) => p === undefined))
    throw new Error("CAPABILITY_UNKNOWN");
  const executors = [
    ...new Set(
      profiles.flatMap((p) => (p?.required_executor === undefined ? [] : [p.required_executor])),
    ),
  ];
  const verified = (models.verified_models[primary] ?? []).filter((alias) =>
    steps.every((s) => models.verified_models[s.capability_profile]?.includes(alias)),
  );
  if (executors.length > 1 || verified.length === 0) throw new Error("PACKET_CAPABILITY_CONFLICT");
  const minEffort = profiles.reduce(
    (floor, p) =>
      p !== undefined && effortRank(p.min_effort) > effortRank(floor) ? p.min_effort : floor,
    first.min_effort,
  );
  return {
    ...models,
    capability_profiles: {
      ...models.capability_profiles,
      [primary]: {
        min_effort: minEffort,
        ...(executors[0] === undefined ? {} : { required_executor: executors[0] }),
      },
    },
    verified_models: { ...models.verified_models, [primary]: verified },
  };
}

/** Scope parsing is never an approval: only the trusted task reader supplies approvalRefs. */
export function taskQualityFacts(
  workflow: Workflow,
  task: {
    readonly complexity: TaskComplexity;
    readonly context: Pick<
      ContextPacket,
      "allowedScope" | "acceptanceCriteria" | "taskSnapshot" | "approvalRefs"
    >;
  },
  step: string,
  round: number,
): QualityPolicyInput {
  const paths = task.context.allowedScope.paths;
  return {
    qualityPolicy: workflow.quality_policy,
    complexity: inferComplexity({
      ...task.complexity,
      acCount: task.context.acceptanceCriteria.length,
    }).complexity,
    step,
    round,
    risks: workflowRisks(paths, task.complexity.area),
    scope: {
      measurableAc: task.context.acceptanceCriteria.length > 0,
      implementationMap: paths.length > 0,
      issueRef: `issue:${String(task.context.taskSnapshot.issueNumber)}`,
      approvalRef: task.context.approvalRefs[0] ?? "",
    },
  };
}
