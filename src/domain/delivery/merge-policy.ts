import { evaluateApproval } from "../approvals/approval-policy.js";
import type { ApprovalExpectation } from "../approvals/approval-policy.js";
import type { Approval } from "../approvals/approval.js";
import { decide } from "../shared/decision.js";
import type { Decision } from "../shared/decision.js";
import { acceptanceReviewRefusals } from "./acceptance-review.js";
import type { AcceptanceReviewRefusal, AcReviewLine } from "./acceptance-review.js";

/** A CI check result as read from GitHub for one commit (by head SHA and check name). */
export interface CheckObservation {
  readonly name: string;
  readonly headSha: string;
  readonly status: "passed" | "failed" | "pending";
}

/** A structured review result pinned to the revision it examined. */
export interface ReviewObservation {
  readonly reviewerRunId: string;
  /** Agent identity (role/profile) of the reviewer; must differ from every implementing agent. */
  readonly reviewerAgentId: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly passed: boolean;
  /** The review's `AC-<n>` verdict lines (`parseAcReviewLines`), not free text. */
  readonly acLines: readonly AcReviewLine[];
}

export interface RequiredApproval {
  readonly approval: Approval | undefined;
  readonly expected: ApprovalExpectation;
}

export type {
  NativeApprovalInputs,
  NativeReviewObservation,
} from "../approvals/native-approval-policy.js";
import type { NativeApprovalInputs } from "../approvals/native-approval-policy.js";
import { nativeApprovalRefusals } from "../approvals/native-approval-policy.js";

/** GitHub's `mergeable_state` of the PR; `draft` also when the PR is a draft. */
export type MergeableState =
  "clean" | "has_hooks" | "unstable" | "blocked" | "behind" | "dirty" | "draft" | "unknown";

export interface MergeInputs {
  readonly pullRequestId: string;
  /** `task` PRs go to the integration branch; `release` PRs need the PO's approval on the head. */
  readonly kind: "task" | "release";
  readonly targetBranch: string;
  readonly expectedTargetBranch: string;
  /** The reviewed head the merge is asked for; the merge call carries it as a head-match guard. */
  readonly expectedHeadSha: string;
  /** Current remote revision, fetched immediately before the decision. */
  readonly currentHeadSha: string;
  readonly currentBaseSha: string;
  readonly linkedIssueConfirmed: boolean;
  readonly mergeableState: MergeableState;
  /** `undefined` when no review result exists; review text like "LGTM" is not an input. */
  readonly review: ReviewObservation | undefined;
  /** Top-level acceptance criteria of the linked Issue (`acceptanceCriteria(body).length`). */
  readonly acceptanceCriteriaCount: number;
  /** Runs and agents that produced the change; the reviewer must be none of them. */
  readonly authorRunIds: readonly string[];
  readonly authorAgentIds: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly checks: readonly CheckObservation[];
  readonly unresolvedMandatoryFindings: number;
  readonly workflowGatesPassed: boolean;
  readonly requiredApprovals: readonly RequiredApproval[];
  readonly nativeApproval: NativeApprovalInputs;
  /** Merges into one branch are serialised by a merge lock. */
  readonly mergeLockHeld: boolean;
}

export type ReviewRefusal =
  | "REVIEW_MISSING"
  | "STALE_REVISION"
  | "REVIEW_NOT_PASSED"
  | "REVIEW_NOT_INDEPENDENT"
  | AcceptanceReviewRefusal;

export type MergeRefusal =
  | "WRONG_TARGET_BRANCH"
  | "ISSUE_LINK_MISSING"
  | "HEAD_MOVED"
  | ReviewRefusal
  | "REQUIRED_CHECK_MISSING"
  | "CHECKS_PENDING"
  | "CHECKS_FAILED"
  | "FINDINGS_UNRESOLVED"
  | "GATE_NOT_PASSED"
  | "APPROVAL_REQUIRED"
  | "NATIVE_CHANGES_REQUESTED"
  | "NATIVE_APPROVAL_MISSING"
  | "PULL_REQUEST_DRAFT"
  | "MERGE_CONFLICT"
  | "BASE_BEHIND"
  | "MERGE_BLOCKED"
  | "MERGEABILITY_UNKNOWN"
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
  if (input.expectedHeadSha !== input.currentHeadSha) refusals.push("HEAD_MOVED");

  refusals.push(
    ...reviewRefusals(input.review, input, {
      headSha: input.currentHeadSha,
      baseSha: input.currentBaseSha,
    }),
  );

  refusals.push(...requiredCheckRefusals(input.requiredChecks, input.checks, input.currentHeadSha));

  if (input.unresolvedMandatoryFindings > 0) refusals.push("FINDINGS_UNRESOLVED");
  if (!input.workflowGatesPassed) refusals.push("GATE_NOT_PASSED");

  const approvalsInvalid = input.requiredApprovals.some(
    ({ approval, expected }) => !evaluateApproval(approval, expected).allowed,
  );
  // The caller builds the expectation, so bind both its PR identity and head to this merge.
  const releaseApprovalMissing =
    input.kind === "release" &&
    !input.requiredApprovals.some(
      ({ expected }) =>
        expected.subject.kind === "release" &&
        expected.subject.pullRequestId === input.pullRequestId &&
        expected.subject.headSha === input.currentHeadSha,
    );
  if (approvalsInvalid || releaseApprovalMissing) refusals.push("APPROVAL_REQUIRED");

  refusals.push(...nativeApprovalRefusals(input.nativeApproval, input.currentHeadSha));
  refusals.push(...mergeableRefusals(input.mergeableState));
  if (!input.mergeLockHeld) refusals.push("MERGE_LOCK_NOT_HELD");

  return decide(refusals);
}

/** Required CI contexts must all pass on the current head. */
export function requiredCheckRefusals(
  requiredChecks: readonly string[],
  checks: readonly CheckObservation[],
  headSha: string,
): ("REQUIRED_CHECK_MISSING" | "CHECKS_PENDING" | "CHECKS_FAILED")[] {
  const refusals: ("REQUIRED_CHECK_MISSING" | "CHECKS_PENDING" | "CHECKS_FAILED")[] = [];
  const forHead = checks.filter((check) => check.headSha === headSha);
  const missing = requiredChecks.filter((name) => !forHead.some((check) => check.name === name));
  const required = forHead.filter((check) => requiredChecks.includes(check.name));
  if (missing.length > 0) refusals.push("REQUIRED_CHECK_MISSING");
  if (required.some((check) => check.status === "pending")) refusals.push("CHECKS_PENDING");
  if (required.some((check) => check.status === "failed")) refusals.push("CHECKS_FAILED");

  return refusals;
}

interface Authors {
  readonly authorRunIds: readonly string[];
  readonly authorAgentIds: readonly string[];
  readonly acceptanceCriteriaCount: number;
}

/**
 * The independent-review gate shared by merge and close: a passing review by a run and agent
 * other than the implementers, pinned to `pinned`, with one `met` line per criterion.
 */
function reviewRefusals(
  review: ReviewObservation | undefined,
  authors: Authors,
  pinned: { readonly headSha: string; readonly baseSha?: string },
): ReviewRefusal[] {
  if (review === undefined) return ["REVIEW_MISSING"];
  const refusals: ReviewRefusal[] = [];
  if (
    review.headSha !== pinned.headSha ||
    (pinned.baseSha !== undefined && review.baseSha !== pinned.baseSha)
  ) {
    refusals.push("STALE_REVISION");
  }
  if (!review.passed) refusals.push("REVIEW_NOT_PASSED");
  // A blank identity cannot prove that the reviewer is someone else.
  if (
    review.reviewerRunId.trim() === "" ||
    review.reviewerAgentId.trim() === "" ||
    authors.authorRunIds.includes(review.reviewerRunId) ||
    authors.authorAgentIds.includes(review.reviewerAgentId)
  ) {
    refusals.push("REVIEW_NOT_INDEPENDENT");
  }
  refusals.push(...acceptanceReviewRefusals(authors.acceptanceCriteriaCount, review.acLines));
  return refusals;
}

/** Only `clean` and `has_hooks` merge without bypassing anything (same rule as ADR-0014). */
export function mergeableRefusals(state: MergeableState): MergeRefusal[] {
  switch (state) {
    case "clean":
    case "has_hooks":
      return [];
    case "draft":
      return ["PULL_REQUEST_DRAFT"];
    case "dirty":
      return ["MERGE_CONFLICT"];
    case "behind":
      return ["BASE_BEHIND"];
    case "blocked":
    case "unstable":
      return ["MERGE_BLOCKED"];
    case "unknown":
      return ["MERGEABILITY_UNKNOWN"];
  }
}

/** What the remote shows after a merge call, read back fresh. */
export interface MergeConfirmationInputs {
  readonly merged: boolean;
  readonly targetBranch: string;
  readonly expectedTargetBranch: string;
  /** Head of the PR when it was merged, and the reviewed head the merge was asked for. */
  readonly mergedHeadSha: string;
  readonly expectedHeadSha: string;
  readonly mergeCommitSha: string | null;
  /** Parents of the merge commit as read from the remote. */
  readonly mergeCommitParents: readonly string[];
  /** The merge commit is reachable from the target branch's current head. */
  readonly mergeCommitOnTarget: boolean;
}

export type MergeConfirmationRefusal =
  | "REMOTE_NOT_MERGED"
  | "WRONG_TARGET_BRANCH"
  | "MERGED_AT_OTHER_HEAD"
  | "MERGE_COMMIT_MISSING"
  | "MERGE_COMMIT_MISMATCH"
  | "MERGE_COMMIT_NOT_ON_TARGET";

/**
 * A merge counts only when the remote confirms it: the PR is merged into the expected branch at
 * the reviewed head, and a merge commit with that head as a parent is on the branch. The answer
 * of the merge call alone is not enough (architecture.md §11 step 6).
 */
export function evaluateMergeConfirmation(
  input: MergeConfirmationInputs,
): Decision<MergeConfirmationRefusal> {
  if (!input.merged) return decide(["REMOTE_NOT_MERGED"]);
  const refusals: MergeConfirmationRefusal[] = [];
  if (input.targetBranch !== input.expectedTargetBranch) refusals.push("WRONG_TARGET_BRANCH");
  if (input.mergedHeadSha !== input.expectedHeadSha) refusals.push("MERGED_AT_OTHER_HEAD");
  if (input.mergeCommitSha === null || input.mergeCommitSha.trim() === "") {
    refusals.push("MERGE_COMMIT_MISSING");
  } else {
    if (!input.mergeCommitParents.includes(input.expectedHeadSha)) {
      refusals.push("MERGE_COMMIT_MISMATCH");
    }
    if (!input.mergeCommitOnTarget) refusals.push("MERGE_COMMIT_NOT_ON_TARGET");
  }
  return decide(refusals);
}

export interface IssueCloseInputs extends Authors {
  /** The PR was merged into the integration branch, as read back from the remote. */
  readonly merged: boolean;
  readonly mergedHeadSha: string;
  /** The recorded review on the merged head, if any. */
  readonly review: ReviewObservation | undefined;
}

export type IssueCloseRefusal = "NOT_MERGED" | ReviewRefusal;

/**
 * Whether the Issue's criteria may be ticked and the Issue closed: the PR is merged, and the
 * independent PASS review on the merged head has a `met` line for every criterion. A missing
 * line or a `not met` refuses; nothing is ticked by hand.
 */
export function evaluateIssueClose(input: IssueCloseInputs): Decision<IssueCloseRefusal> {
  const refusals: IssueCloseRefusal[] = [];
  if (!input.merged) refusals.push("NOT_MERGED");
  refusals.push(...reviewRefusals(input.review, input, { headSha: input.mergedHeadSha }));
  return decide(refusals);
}
