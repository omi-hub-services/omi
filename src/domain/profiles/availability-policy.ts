import { decide } from "../shared/decision.js";
import type { Decision } from "../shared/decision.js";
import type { ProfileState } from "./profile-state.js";

export interface ProfileObservation {
  readonly state: ProfileState;
  /** Epoch ms of the last successful probe; absent when never probed. */
  readonly lastProbeAt?: number;
  /** Epoch ms when a cooldown ends; meaningful in the `cooldown` state. */
  readonly cooldownUntil?: number;
  readonly activeWorkers: number;
  readonly maxConcurrency: number;
}

export type UnavailableReason =
  | "PROFILE_DISABLED"
  | "LOGIN_REQUIRED"
  | "PROFILE_UNAVAILABLE"
  | "COOLDOWN_ACTIVE"
  | "NOT_PROBED"
  | "PROBE_STALE"
  | "AT_CONCURRENCY_LIMIT";

/**
 * Whether a profile may take a new worker at `now`. Availability is a time-stamped observation
 * (design-patterns.md §5): `unknown`, a stale probe and an expired cooldown are all "not ready"
 * until a fresh probe says so. `now` and the probe TTL are passed in; nothing reads a clock.
 */
export function evaluateProfileAvailability(
  profile: ProfileObservation,
  now: number,
  probeTtlMs: number,
): Decision<UnavailableReason> {
  const refusals: UnavailableReason[] = [];
  switch (profile.state) {
    case "disabled":
      refusals.push("PROFILE_DISABLED");
      break;
    case "login-required":
      refusals.push("LOGIN_REQUIRED");
      break;
    case "unavailable":
      refusals.push("PROFILE_UNAVAILABLE");
      break;
    case "cooldown":
      if (profile.cooldownUntil !== undefined && now < profile.cooldownUntil) {
        refusals.push("COOLDOWN_ACTIVE");
      } else {
        // Cooldown over: not ready until probed again.
        refusals.push("NOT_PROBED");
      }
      break;
    case "unknown":
      refusals.push("NOT_PROBED");
      break;
    case "ready":
    case "busy":
      if (profile.lastProbeAt === undefined) {
        refusals.push("NOT_PROBED");
      } else if (now - profile.lastProbeAt >= probeTtlMs) {
        refusals.push("PROBE_STALE");
      }
      break;
  }
  if (refusals.length === 0 && profile.activeWorkers >= profile.maxConcurrency) {
    refusals.push("AT_CONCURRENCY_LIMIT");
  }
  return decide(refusals);
}
