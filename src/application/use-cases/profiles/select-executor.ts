import { resolveWorkflowEffort } from "../../../domain/workflows/workflow-policy.js";
import { stepQualitySchema } from "../../contracts/workflow.js";
import { taskComplexitySchema, effortPolicySchema } from "../../contracts/task-complexity.js";
import { z } from "zod";
import { selectExecutor as selectByPolicy } from "../../../domain/agents/selection-policy.js";
import { observedProfile } from "../../../domain/profiles/profile-metadata.js";
import type { QuotaVerdict } from "../../../domain/profiles/quota-policy.js";
import { identifierSchema, slugSchema } from "../../contracts/identifiers.js";
import { executorSchema, modelsConfigSchema } from "../../contracts/model-capability.js";
import type { ExecutorSelectionStore } from "../../ports/executor-selection-store.js";

const requestSchema = z.strictObject({
  quality: stepQualitySchema.optional(),
  attemptId: identifierSchema,
  stepRunId: identifierSchema,
  attemptNumber: z.number().int().positive(),
  capabilityProfile: slugSchema,
  requiredExecutor: executorSchema.optional(),
  now: z.number().int().nonnegative(),
  models: modelsConfigSchema,
  task: taskComplexitySchema,
  effortPolicy: effortPolicySchema,
  /** Trusted verdicts the caller computed from quota readings; never worker or Issue text. */
  quota: z.custom<ReadonlyMap<string, QuotaVerdict>>((value) => value instanceof Map).optional(),
});

export function selectExecutor(store: ExecutorSelectionStore, input: unknown) {
  const request = requestSchema.parse(input);
  const capability = request.models.capability_profiles[request.capabilityProfile];
  if (capability === undefined) throw new Error("Unknown capability profile");
  if (
    capability.required_executor !== undefined &&
    request.requiredExecutor !== undefined &&
    capability.required_executor !== request.requiredExecutor
  ) {
    throw new Error("Executor requirement conflicts with capability profile");
  }
  const decision = resolveWorkflowEffort(
    request.task,
    request.effortPolicy,
    capability.min_effort,
    request.quality,
  );
  const requiredExecutor = capability.required_executor ?? request.requiredExecutor;
  const verified = request.models.verified_models[request.capabilityProfile] ?? [];
  const result = store.reserve(
    {
      id: request.attemptId,
      stepRunId: request.stepRunId,
      number: request.attemptNumber,
      at: request.now,
      selectionReason: decision.reason,
    },
    (profiles) => {
      const cooldownGroups = new Set(
        profiles
          .filter(
            ({ metadata }) =>
              metadata.state === "cooldown" &&
              metadata.cooldownUntil !== undefined &&
              metadata.cooldownUntil > request.now,
          )
          .map(({ metadata }) => metadata.accountGroupId),
      );
      return selectByPolicy({
        requirement: { minEffort: decision.minEffort },
        now: request.now,
        probeTtlMs: 1, // Every candidate supplies its own configured TTL.
        ...(requiredExecutor === undefined ? {} : { requiredExecutor }),
        cooldownAccountGroups: cooldownGroups,
        ...(request.quota === undefined ? {} : { quota: request.quota }),
        preferQuota: request.quality?.step === "verify" || request.quality?.step === "review",
        candidates: profiles.flatMap((profile) => {
          const metadata = profile.metadata;
          const group = profiles.filter(
            (entry) => entry.metadata.accountGroupId === metadata.accountGroupId,
          );
          return Object.entries(request.models.models)
            .filter(([, model]) => model.executor === metadata.tool)
            .map(([alias, model]) => ({
              candidateId: `${metadata.profileId}:${alias}`,
              executor: metadata.tool,
              modelAlias: alias,
              model: model.model,
              modelAllowlist: metadata.modelAllowlist,
              profileId: metadata.profileId,
              accountGroupId: metadata.accountGroupId,
              profile: observedProfile(profile, request.now),
              supportedEfforts: model.supported_efforts,
              verifiedForCapability: verified.includes(alias),
              preference: metadata.preference,
              probeTtlMs: metadata.probeTtlMs,
              accountGroupActiveWorkers: group.reduce((sum, entry) => sum + entry.activeWorkers, 0),
              accountGroupMaxConcurrency: Math.min(
                ...group.map((entry) => entry.metadata.accountGroupMaxConcurrency),
              ),
            }));
        }),
      });
    },
  );
  return result.outcome === "selected"
    ? { ...result, decision }
    : {
        outcome: "waiting_resource" as const,
        reason: "NO_MATCHING_COMBINATION" as const,
        rejections: result.rejections,
        decision,
      };
}
