import { evaluateApproval } from "../approvals/approval-policy.js";
import type { ApprovalExpectation } from "../approvals/approval-policy.js";
import type { Approval } from "../approvals/approval.js";
import { decide } from "../shared/decision.js";
import type { Decision } from "../shared/decision.js";

/** A CI check result as read from GitHub for one commit (by head SHA and check name). */
export interface CheckObservation {
  readonly name: string;
  readonly headSha: string;
  readonly status: "passed" | "failed" | "pending";
}

/** A structured review result pinned to the revision it examined. */
export interface ReviewObservation {
  readonly reviewerRunId: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly passed: boolean;
}

export interface RequiredApproval {
  readonly approval: Approval | undefined;
  readonly expected: ApprovalExpectation;
}

export interface MergeInputs {
  /** `task` PRs go to the integration branch; `release` PRs need the PO's approval on the head. */
  readonly kind: "task" | "release";
  readonly targetBranch: string;
  readonly expectedTargetBranch: string;
  /** Current remote revision, fetched immediately before the decision. */
  readonly currentHeadSha: string;
  readonly currentBaseSha: string;
  readonly linkedIssueConfirmed: boolean;
  readonly hasConflicts: boolean;
  /** `undefined` when no review result exists; review text like "LGTM" is not an input. */
  readonly review: ReviewObservation | undefined;
  /** Runs that produced the change; the reviewer must not be one of them. */
  readonly authorRunIds: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly checks: readonly CheckObservation[];
  readonly unresolvedMandatoryFindings: number;
  readonly workflowGatesPassed: boolean;
  readonly requiredApprovals: readonly RequiredApproval[];
  /** Merges into one branch are serialised by a merge lock. */
  readonly mergeLockHeld: boolean;
}

export type MergeRefusal =
  | "WRONG_TARGET_BRANCH"
  | "ISSUE_LINK_MISSING"
  | "REVIEW_MISSING"
  | "STALE_REVISION"
  | "REVIEW_NOT_PASSED"
  | "REVIEW_NOT_INDEPENDENT"
  | "REQUIRED_CHECK_MISSING"
  | "CHECKS_PENDING"
  | "CHECKS_FAILED"
  | "FINDINGS_UNRESOLVED"
  | "GATE_NOT_PASSED"
  | "APPROVAL_REQUIRED"
  | "MERGE_CONFLICT"
  | "MERGE_LOCK_NOT_HELD";

/**
 * Decides whether a PR may be merged now (product overview §9.2, architecture.md §11,
 * design-patterns.md §3). Evidence for an older revision never authorises a changed one:
 * the review must be for the current head and base, and a check counts only when it was
 * reported for the current head SHA, matched by name. A GitHub approval can survive a push
 * (ADR-0015), so approvals are re-evaluated against the current head here.
 * All failed reasons are returned, in priority order.
 */
export function evaluateMerge(input: MergeInputs): Decision<MergeRefusal> {
  const refusals: MergeRefusal[] = [];

  if (input.targetBranch !== input.expectedTargetBranch) refusals.push("WRONG_TARGET_BRANCH");
  if (!input.linkedIssueConfirmed) refusals.push("ISSUE_LINK_MISSING");

  const review = input.review;
  if (review === undefined) {
    refusals.push("REVIEW_MISSING");
  } else {
    if (review.headSha !== input.currentHeadSha || review.baseSha !== input.currentBaseSha) {
      refusals.push("STALE_REVISION");
    }
    if (!review.passed) refusals.push("REVIEW_NOT_PASSED");
    if (input.authorRunIds.includes(review.reviewerRunId)) refusals.push("REVIEW_NOT_INDEPENDENT");
  }

  const forHead = input.checks.filter((check) => check.headSha === input.currentHeadSha);
  const missing = input.requiredChecks.filter(
    (name) => !forHead.some((check) => check.name === name),
  );
  const required = forHead.filter((check) => input.requiredChecks.includes(check.name));
  if (missing.length > 0) refusals.push("REQUIRED_CHECK_MISSING");
  if (required.some((check) => check.status === "pending")) refusals.push("CHECKS_PENDING");
  if (required.some((check) => check.status === "failed")) refusals.push("CHECKS_FAILED");

  if (input.unresolvedMandatoryFindings > 0) refusals.push("FINDINGS_UNRESOLVED");
  if (!input.workflowGatesPassed) refusals.push("GATE_NOT_PASSED");

  const approvalsInvalid = input.requiredApprovals.some(
    ({ approval, expected }) => !evaluateApproval(approval, expected).allowed,
  );
  // A release PR needs a valid release approval for the head being merged. The expectation is
  // built by the caller, so the head it names is checked here against the remote head.
  const releaseApprovalMissing =
    input.kind === "release" &&
    !input.requiredApprovals.some(
      ({ expected }) =>
        expected.subject.kind === "release" && expected.subject.headSha === input.currentHeadSha,
    );
  if (approvalsInvalid || releaseApprovalMissing) refusals.push("APPROVAL_REQUIRED");

  if (input.hasConflicts) refusals.push("MERGE_CONFLICT");
  if (!input.mergeLockHeld) refusals.push("MERGE_LOCK_NOT_HELD");

  return decide(refusals);
}
