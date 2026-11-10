/**
 * Operational retry policy (design-patterns.md §11). Infrastructure failures have their own
 * bounded budget and never spend the quality budget of rework-policy.ts. Time and jitter are
 * values passed in, so the policy is deterministic and testable without a clock or sleep.
 */

export type OperationalFailure =
  | "rate_limit"
  | "network"
  | "process_died"
  | "login_required"
  | "invalid_config"
  | "remote_outcome_unknown"
  | "unclassified";

export interface RetryBudget {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface RetryInput {
  readonly failure: OperationalFailure;
  /** Retries already made for this operation (0 on the first failure). */
  readonly retriesMade: number;
  readonly now: number;
  /** Random value in [0, 1) supplied by the caller; spreads retries. */
  readonly jitter: number;
  readonly budget: RetryBudget;
  /** Real cooldown end reported by the tool, when it exposes one (epoch ms). */
  readonly cooldownUntil?: number;
}

export type RetryStopReason =
  "RETRY_BUDGET_EXHAUSTED" | "LOGIN_REQUIRED" | "INVALID_CONFIG" | "UNCLASSIFIED_FAILURE";

export type RetryAction =
  /** Try again no earlier than `notBefore` (epoch ms). */
  | { readonly action: "retry"; readonly notBefore: number }
  /** Rate limit: checkpoint, put the account group in cooldown, pick another capable profile. */
  | { readonly action: "failover"; readonly cooldownUntil: number }
  /** Read the remote first; never repeat a call whose outcome is unknown. */
  | { readonly action: "reconcile_first" }
  /** Recover (reconcile workspace and process) before dispatching the step again. */
  | { readonly action: "recover" }
  | { readonly action: "stop"; readonly reason: RetryStopReason };

/** Exponential backoff with equal jitter, capped at `maxDelayMs`. */
export function backoffDelayMs(retriesMade: number, jitter: number, budget: RetryBudget): number {
  const exponential = Math.min(budget.maxDelayMs, budget.baseDelayMs * 2 ** retriesMade);
  const clampedJitter = Math.min(Math.max(jitter, 0), 0.999999);
  return Math.floor(exponential / 2 + (exponential / 2) * clampedJitter);
}

export function decideOperationalRetry(input: RetryInput): RetryAction {
  switch (input.failure) {
    case "login_required":
      return { action: "stop", reason: "LOGIN_REQUIRED" };
    case "invalid_config":
      return { action: "stop", reason: "INVALID_CONFIG" };
    case "unclassified":
      // Keep the evidence and stop safely; never assume it was a limit.
      return { action: "stop", reason: "UNCLASSIFIED_FAILURE" };
    case "remote_outcome_unknown":
      return { action: "reconcile_first" };
    default:
      break;
  }
  if (input.retriesMade >= input.budget.maxAttempts) {
    return { action: "stop", reason: "RETRY_BUDGET_EXHAUSTED" };
  }
  const backoff = input.now + backoffDelayMs(input.retriesMade, input.jitter, input.budget);
  switch (input.failure) {
    case "rate_limit":
      return { action: "failover", cooldownUntil: input.cooldownUntil ?? backoff };
    case "process_died":
      return { action: "recover" };
    case "network":
      return { action: "retry", notBefore: backoff };
  }
}
