import { applyTransition, ruleBuilder } from "../shared/transition.js";
import type { TransitionOutcome, TransitionRule } from "../shared/transition.js";

/**
 * Local profile availability (architecture.md §7). Observations, not permanent properties:
 * `unknown` is never shown or used as `ready`. No token, path or credential is modelled here.
 */
export const PROFILE_STATES = [
  "unknown",
  "ready",
  "busy",
  "cooldown",
  "login-required",
  "unavailable",
  "disabled",
] as const;
export type ProfileState = (typeof PROFILE_STATES)[number];

export type ProfileEvent =
  | { readonly type: "probe_succeeded" }
  | { readonly type: "probe_failed" }
  | {
      readonly type: "capacity_reached";
      readonly activeWorkers: number;
      readonly maxConcurrency: number;
    }
  | {
      readonly type: "capacity_freed";
      readonly activeWorkers: number;
      readonly maxConcurrency: number;
    }
  | { readonly type: "limit_hit"; readonly now: number; readonly cooldownUntil: number }
  | { readonly type: "cooldown_elapsed"; readonly now: number; readonly cooldownUntil: number }
  | { readonly type: "login_failed" }
  | { readonly type: "login_completed" }
  | { readonly type: "disable" }
  | { readonly type: "enable" };

export type ProfileRefusal =
  | "BELOW_CONCURRENCY_LIMIT"
  | "AT_CONCURRENCY_LIMIT"
  | "COOLDOWN_NOT_IN_FUTURE"
  | "COOLDOWN_NOT_ELAPSED";

const rule = ruleBuilder<ProfileState, ProfileEvent, ProfileRefusal>();

const anyEnabled: readonly ProfileState[] = [
  "unknown",
  "ready",
  "busy",
  "cooldown",
  "login-required",
  "unavailable",
];

export const PROFILE_RULES: readonly TransitionRule<ProfileState, ProfileEvent, ProfileRefusal>[] =
  [
    // A successful probe says nothing about a running worker: busy stays busy.
    rule("unknown", "probe_succeeded", "ready"),
    rule("ready", "probe_succeeded", "ready"),
    rule("unavailable", "probe_succeeded", "ready"),
    rule("busy", "probe_succeeded", "busy"),
    rule("unknown", "probe_failed", "unavailable"),
    rule("ready", "probe_failed", "unavailable"),
    rule("unavailable", "probe_failed", "unavailable"),
    rule("ready", "capacity_reached", "busy", (e) =>
      e.activeWorkers >= e.maxConcurrency ? undefined : "BELOW_CONCURRENCY_LIMIT",
    ),
    rule("busy", "capacity_freed", "ready", (e) =>
      e.activeWorkers < e.maxConcurrency ? undefined : "AT_CONCURRENCY_LIMIT",
    ),
    ...(["ready", "busy", "unknown"] as const).map((from) =>
      rule(from, "limit_hit", "cooldown", (e) =>
        e.cooldownUntil > e.now ? undefined : "COOLDOWN_NOT_IN_FUTURE",
      ),
    ),
    // After a cooldown the profile is unknown again: it must be probed before it counts as ready.
    rule("cooldown", "cooldown_elapsed", "unknown", (e) =>
      e.now >= e.cooldownUntil ? undefined : "COOLDOWN_NOT_ELAPSED",
    ),
    ...anyEnabled.map((from) => rule(from, "login_failed", "login-required")),
    rule("login-required", "login_completed", "unknown"),
    ...anyEnabled.map((from) => rule(from, "disable", "disabled")),
    rule("disabled", "enable", "unknown"),
  ];

export function transitionProfile(
  from: ProfileState,
  event: ProfileEvent,
): TransitionOutcome<ProfileState, ProfileRefusal> {
  return applyTransition(PROFILE_RULES, from, event);
}
