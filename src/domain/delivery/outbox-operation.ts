import { applyTransition, ruleBuilder } from "../shared/transition.js";
import type { TransitionOutcome, TransitionRule } from "../shared/transition.js";

/**
 * Lifecycle of one outbox operation, i.e. one external (GitHub) side effect recorded as an
 * intent before the remote call (architecture.md §11, design-patterns.md §7).
 *
 * The machine encodes the safety rule of the outbox: **a send is only ever started from
 * `pending`, and `pending` is only reached when the remote is known not to hold the effect** —
 * either it was never attempted, the remote refused it, or a read-back found no trace of it
 * after a grace period. An attempt with an unknown outcome (`outcome_unknown`) has no way back
 * to `in_flight`; its only exits are remote read-backs. This is idempotency by reconciliation,
 * not an exactly-once guarantee: a read-back can only prove what the remote shows.
 *
 * The SQLite CHECK on `outbox.state` (migration 0003) lists exactly `OUTBOX_STATES`.
 */
export const OUTBOX_STATES = [
  "pending",
  "in_flight",
  "outcome_unknown",
  "succeeded",
  "failed",
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export function isOutboxState(value: string): value is OutboxState {
  return (OUTBOX_STATES as readonly string[]).includes(value);
}

/** `succeeded` is final; `failed` is only reopened by a recorded decision. */
export function isTerminalOutboxState(state: OutboxState): boolean {
  return state === "succeeded" || state === "failed";
}

export type OutboxEvent =
  | {
      readonly type: "begin_attempt";
      readonly now: number;
      /** Epoch ms before which the operation must not be sent (Retry-After, backoff); 0 for none. */
      readonly notBefore: number;
      /** Attempts already started, and the budget for this operation. */
      readonly attemptCount: number;
      readonly maxAttempts: number;
    }
  | { readonly type: "attempt_succeeded"; readonly remoteIdentity: string }
  /** The remote refused the request and applied nothing (rate limit, secondary limit). */
  | { readonly type: "attempt_rejected_retry" }
  /** The remote refused the request and applied nothing, and retrying cannot help. */
  | { readonly type: "attempt_rejected_final" }
  /** Timeout, lost response or a crash during the call: the remote may hold the effect. */
  | { readonly type: "attempt_outcome_unknown" }
  | { readonly type: "reconciled_found"; readonly remoteIdentity: string }
  | {
      readonly type: "reconciled_absent";
      readonly now: number;
      /** When the unknown outcome was recorded (epoch ms). */
      readonly outcomeUnknownSince: number;
      /** A request that timed out may still be running remotely; absence is only trusted later. */
      readonly graceMs: number;
    }
  | { readonly type: "give_up"; readonly reason: string }
  | { readonly type: "reopen"; readonly decisionId: string };

export type OutboxRefusal =
  | "NOT_DUE"
  | "RETRY_BUDGET_EXHAUSTED"
  | "REMOTE_IDENTITY_MISSING"
  | "RECONCILE_TOO_EARLY"
  | "REASON_MISSING"
  | "REOPEN_DECISION_MISSING";

const rule = ruleBuilder<OutboxState, OutboxEvent, OutboxRefusal>();

const hasText = (value: string): boolean => value.trim() !== "";

export const OUTBOX_RULES: readonly TransitionRule<OutboxState, OutboxEvent, OutboxRefusal>[] = [
  rule("pending", "begin_attempt", "in_flight", (e) => {
    if (e.now < e.notBefore) return "NOT_DUE";
    return e.attemptCount >= e.maxAttempts ? "RETRY_BUDGET_EXHAUSTED" : undefined;
  }),
  rule("in_flight", "attempt_succeeded", "succeeded", (e) =>
    hasText(e.remoteIdentity) ? undefined : "REMOTE_IDENTITY_MISSING",
  ),
  rule("in_flight", "attempt_rejected_retry", "pending"),
  rule("in_flight", "attempt_rejected_final", "failed"),
  rule("in_flight", "attempt_outcome_unknown", "outcome_unknown"),
  rule("outcome_unknown", "reconciled_found", "succeeded", (e) =>
    hasText(e.remoteIdentity) ? undefined : "REMOTE_IDENTITY_MISSING",
  ),
  rule("outcome_unknown", "reconciled_absent", "pending", (e) =>
    e.now - e.outcomeUnknownSince >= e.graceMs ? undefined : "RECONCILE_TOO_EARLY",
  ),
  // Only a send that has not started can be abandoned: spent budget, or a payload that is unusable.
  rule("pending", "give_up", "failed", (e) => (hasText(e.reason) ? undefined : "REASON_MISSING")),
  rule("failed", "reopen", "pending", (e) =>
    hasText(e.decisionId) ? undefined : "REOPEN_DECISION_MISSING",
  ),
];

export function transitionOutbox(
  from: OutboxState,
  event: OutboxEvent,
): TransitionOutcome<OutboxState, OutboxRefusal> {
  return applyTransition(OUTBOX_RULES, from, event);
}
