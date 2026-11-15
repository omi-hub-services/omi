import { evaluateProfileAvailability, type ProfileObservation } from "./availability-policy.js";
import type { ProfileState } from "./profile-state.js";

/** Verified local configuration, never a login cache or inferred subscription capability. */
export interface ProfileMetadata {
  readonly profileId: string;
  readonly tool: "claude-code" | "codex";
  readonly authMode: "subscription";
  /** Isolated profile directory reference, not an auth-file reference or its contents. */
  readonly credentialRef: string;
  readonly accountGroupId: string;
  readonly modelAllowlist: readonly string[];
  readonly state: ProfileState;
  readonly lastProbeAt?: number;
  readonly cooldownUntil?: number;
  readonly probeTtlMs: number;
  readonly maxConcurrency: number;
  readonly accountGroupMaxConcurrency: number;
  readonly preference: number;
}

export interface RegisteredProfile {
  readonly metadata: ProfileMetadata;
  readonly revision: number;
  /** Includes reserved pending attempts and running attempts; never counts model candidates. */
  readonly activeWorkers: number;
}

/** Read-time projection: expired evidence is unknown, while actionable login/disable states remain. */
export function observedProfile(profile: RegisteredProfile, now: number): ProfileObservation {
  const metadata = profile.metadata;
  const observation: ProfileObservation = {
    state: metadata.state,
    ...(metadata.lastProbeAt === undefined ? {} : { lastProbeAt: metadata.lastProbeAt }),
    ...(metadata.cooldownUntil === undefined ? {} : { cooldownUntil: metadata.cooldownUntil }),
    activeWorkers: profile.activeWorkers,
    maxConcurrency: metadata.maxConcurrency,
  };
  const availability = evaluateProfileAvailability(observation, now, metadata.probeTtlMs);
  if (
    !availability.allowed &&
    availability.reasons.some((reason) => reason === "NOT_PROBED" || reason === "PROBE_STALE")
  ) {
    return { ...observation, state: "unknown" };
  }
  return observation;
}
