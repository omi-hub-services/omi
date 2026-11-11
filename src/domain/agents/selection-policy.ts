import { evaluateProfileAvailability } from "../profiles/availability-policy.js";
import type { ProfileObservation, UnavailableReason } from "../profiles/availability-policy.js";
import { lowestSatisfyingEffort } from "./capability.js";
import type { CapabilityRequirement, Effort } from "./capability.js";

export interface ExecutorCandidate {
  readonly candidateId: string;
  readonly executor: string;
  /** Model alias from `models.yaml`. */
  readonly modelAlias: string;
  readonly model: string;
  readonly modelAllowlist: readonly string[];
  readonly profileId: string;
  /** Profiles of one account share a quota; a cooldown on the group hits all of them. */
  readonly accountGroupId: string;
  readonly profile: ProfileObservation;
  readonly supportedEfforts: readonly Effort[];
  /** The alias is listed in `verified_models` for the step's capability profile. */
  readonly verifiedForCapability: boolean;
  /** Configured preference, lower is preferred. Only ranks candidates that qualify. */
  readonly preference: number;
  readonly probeTtlMs?: number;
  readonly accountGroupActiveWorkers: number;
  readonly accountGroupMaxConcurrency: number;
}

export type CandidateRejection =
  | UnavailableReason
  | "ACCOUNT_GROUP_IN_COOLDOWN"
  | "MODEL_NOT_VERIFIED"
  | "EFFORT_BELOW_MINIMUM"
  | "MODEL_NOT_ALLOWLISTED"
  | "ACCOUNT_GROUP_AT_CONCURRENCY_LIMIT"
  | "REQUIRED_EXECUTOR_MISMATCH";

export interface SelectionInput {
  readonly requirement: CapabilityRequirement;
  readonly candidates: readonly ExecutorCandidate[];
  /** Account groups with an active cooldown (circuit open). */
  readonly cooldownAccountGroups: ReadonlySet<string>;
  readonly now: number;
  readonly probeTtlMs: number;
  readonly requiredExecutor?: string;
}

export type SelectionResult =
  | {
      readonly outcome: "selected";
      readonly candidate: ExecutorCandidate;
      readonly effort: Effort;
    }
  | {
      /** Nobody qualifies: the step waits for a resource, with the reason per candidate. */
      readonly outcome: "WAITING_RESOURCE";
      readonly rejections: readonly {
        readonly candidateId: string;
        readonly reasons: readonly CandidateRejection[];
      }[];
    };

/**
 * Hard requirements first, preference second (design-patterns.md §5): availability, account
 * group circuit, verified model, effort >= minimum, concurrency. Preference then load only
 * order the qualifying candidates, so reordering preferences can never drop the capability
 * floor or pick a candidate just because it has quota left.
 */
export function selectExecutor(input: SelectionInput): SelectionResult {
  const qualifying: { candidate: ExecutorCandidate; effort: Effort }[] = [];
  const rejections: { candidateId: string; reasons: readonly CandidateRejection[] }[] = [];

  for (const candidate of input.candidates) {
    const reasons: CandidateRejection[] = [];
    const availability = evaluateProfileAvailability(
      candidate.profile,
      input.now,
      candidate.probeTtlMs ?? input.probeTtlMs,
    );
    if (!availability.allowed) reasons.push(...availability.reasons);
    if (input.cooldownAccountGroups.has(candidate.accountGroupId)) {
      reasons.push("ACCOUNT_GROUP_IN_COOLDOWN");
    }
    if (!candidate.verifiedForCapability) reasons.push("MODEL_NOT_VERIFIED");
    if (!candidate.modelAllowlist.includes(candidate.model)) reasons.push("MODEL_NOT_ALLOWLISTED");
    if (input.requiredExecutor !== undefined && input.requiredExecutor !== candidate.executor) {
      reasons.push("REQUIRED_EXECUTOR_MISMATCH");
    }
    const effort = lowestSatisfyingEffort(input.requirement, candidate.supportedEfforts);
    if (effort === undefined) reasons.push("EFFORT_BELOW_MINIMUM");
    if (candidate.accountGroupActiveWorkers >= candidate.accountGroupMaxConcurrency) {
      reasons.push("ACCOUNT_GROUP_AT_CONCURRENCY_LIMIT");
    }

    if (reasons.length === 0 && effort !== undefined) {
      qualifying.push({ candidate, effort });
    } else {
      rejections.push({ candidateId: candidate.candidateId, reasons });
    }
  }

  const best = [...qualifying].sort(
    (a, b) =>
      a.candidate.preference - b.candidate.preference ||
      a.candidate.profile.activeWorkers - b.candidate.profile.activeWorkers ||
      a.candidate.candidateId.localeCompare(b.candidate.candidateId),
  )[0];
  if (best === undefined) {
    return { outcome: "WAITING_RESOURCE", rejections };
  }
  return { outcome: "selected", candidate: best.candidate, effort: best.effort };
}
