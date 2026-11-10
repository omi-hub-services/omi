import { applyTransition, ruleBuilder } from "../shared/transition.js";
import type { TransitionOutcome, TransitionRule } from "../shared/transition.js";

/**
 * An approval is a versioned decision about one subject, never an `approved: true` flag
 * (design-patterns.md §10). What the subject pins depends on the kind:
 * - business: the requirement baseline hash and the scope ids it covers (a README edit does
 *   not touch it, so it is not re-asked mechanically);
 * - release: the PR and its exact head SHA. GitHub itself lets an approval survive a push
 *   unless the ruleset dismisses it (ADR-0015), so the domain binds approval to the head;
 * - deploy: the immutable artifact digest and the environment. Never a release approval.
 */
export type ApprovalSubject =
  | {
      readonly kind: "business";
      readonly baselineHash: string;
      readonly scopeIds: readonly string[];
    }
  | { readonly kind: "release"; readonly pullRequestId: string; readonly headSha: string }
  | {
      readonly kind: "deploy";
      readonly artifactDigest: string;
      readonly environment: string;
    };

export type ApprovalKind = ApprovalSubject["kind"];

/** Where the decision came from. Worker output and agent-written text are not a source. */
export type ApprovalSource = "po-cli" | "github-actor" | "po-conversation";

export interface Approval {
  readonly id: string;
  readonly subject: ApprovalSubject;
  readonly decision: "approved" | "rejected";
  readonly actor: string;
  readonly source: ApprovalSource;
  /** Evidence of the real PO message; required when the source is a conversation. */
  readonly evidenceRef?: string;
  readonly decidedAt: number;
  /** Epoch ms after which the approval no longer holds; absent means it does not expire. */
  readonly expiresAt?: number;
  readonly reason?: string;
}

/**
 * Lifecycle of an approval request. Who may approve (allowlist, author) is checked in one place,
 * `evaluateApproval` in approval-policy.ts, every time an approval is used, not here.
 */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "invalidated",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type ApprovalEvent =
  | {
      readonly type: "approve";
      readonly sourceAuthenticated: boolean;
      readonly subjectCurrent: boolean;
    }
  | {
      readonly type: "reject";
      readonly sourceAuthenticated: boolean;
      readonly reason: string;
    }
  | { readonly type: "expire"; readonly now: number; readonly expiresAt: number }
  | { readonly type: "invalidate"; readonly subjectChanged: boolean };

export type ApprovalRefusal =
  | "SOURCE_NOT_AUTHENTICATED"
  | "SUBJECT_STALE"
  | "REJECTION_REASON_MISSING"
  | "NOT_EXPIRED_YET"
  | "SUBJECT_UNCHANGED";

const rule = ruleBuilder<ApprovalStatus, ApprovalEvent, ApprovalRefusal>();

export const APPROVAL_RULES: readonly TransitionRule<
  ApprovalStatus,
  ApprovalEvent,
  ApprovalRefusal
>[] = [
  rule("pending", "approve", "approved", (e) => {
    if (!e.sourceAuthenticated) return "SOURCE_NOT_AUTHENTICATED";
    return e.subjectCurrent ? undefined : "SUBJECT_STALE";
  }),
  rule("pending", "reject", "rejected", (e) => {
    if (!e.sourceAuthenticated) return "SOURCE_NOT_AUTHENTICATED";
    return e.reason.trim() === "" ? "REJECTION_REASON_MISSING" : undefined;
  }),
  ...(["pending", "approved"] as const).map((from) =>
    rule(from, "expire", "expired", (e) => (e.now >= e.expiresAt ? undefined : "NOT_EXPIRED_YET")),
  ),
  ...(["pending", "approved"] as const).map((from) =>
    rule(from, "invalidate", "invalidated", (e) =>
      e.subjectChanged ? undefined : "SUBJECT_UNCHANGED",
    ),
  ),
];

export function transitionApproval(
  from: ApprovalStatus,
  event: ApprovalEvent,
): TransitionOutcome<ApprovalStatus, ApprovalRefusal> {
  return applyTransition(APPROVAL_RULES, from, event);
}
