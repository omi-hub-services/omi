import { describe, expect, it } from "vitest";
import type { Approval } from "../../../../src/domain/approvals/approval.ts";
import { parseAcReviewLines } from "../../../../src/domain/delivery/acceptance-review.ts";
import {
  evaluateIssueClose,
  evaluateMerge,
  evaluateMergeConfirmation,
} from "../../../../src/domain/delivery/merge-policy.ts";
import type {
  IssueCloseInputs,
  MergeConfirmationInputs,
  MergeInputs,
  NativeReviewObservation,
  ReviewObservation,
} from "../../../../src/domain/delivery/merge-policy.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);

const ALL_MET = parseAcReviewLines("AC-1: met — unit test\nAC-2: met — e2e test");

const review = (overrides: Partial<ReviewObservation> = {}): ReviewObservation => ({
  reviewerRunId: "run-review",
  reviewerAgentId: "agent-reviewer",
  headSha: HEAD,
  baseSha: BASE,
  passed: true,
  acLines: ALL_MET,
  ...overrides,
});

const taskPr = (overrides: Partial<MergeInputs> = {}): MergeInputs => ({
  pullRequestId: "pr-1",
  kind: "task",
  targetBranch: "develop",
  expectedTargetBranch: "develop",
  expectedHeadSha: HEAD,
  currentHeadSha: HEAD,
  currentBaseSha: BASE,
  linkedIssueConfirmed: true,
  mergeableState: "clean",
  review: review(),
  acceptanceCriteriaCount: 2,
  authorRunIds: ["run-impl"],
  authorAgentIds: ["agent-impl"],
  requiredChecks: ["ci", "architecture"],
  checks: [
    { name: "ci", headSha: HEAD, status: "passed" },
    { name: "architecture", headSha: HEAD, status: "passed" },
  ],
  unresolvedMandatoryFindings: 0,
  workflowGatesPassed: true,
  requiredApprovals: [],
  nativeApproval: { requiredCount: 0, pullAuthor: "omi-bot", runtimeActors: [], reviews: [] },
  mergeLockHeld: true,
  ...overrides,
});

const poApproval = (headSha: string): Approval => ({
  id: "ap-1",
  subject: { kind: "release", pullRequestId: "pr-1", headSha },
  decision: "approved",
  actor: "po",
  source: "github-actor",
  decidedAt: 1,
});
const releaseApproval = (approval: Approval | undefined) => ({
  approval,
  expected: {
    subject: { kind: "release", pullRequestId: "pr-1", headSha: HEAD } as const,
    allowedActors: ["po"],
    authorActor: "agent",
    now: 10,
  },
});

describe("evaluateMerge", () => {
  it("allows a task PR when every gate passed", () => {
    expect(evaluateMerge(taskPr())).toEqual({ allowed: true });
  });

  it("refuses a wrong target branch", () => {
    expect(evaluateMerge(taskPr({ targetBranch: "main" }))).toMatchObject({
      reason: "WRONG_TARGET_BRANCH",
    });
  });

  it("refuses without a confirmed PR-Issue link", () => {
    expect(evaluateMerge(taskPr({ linkedIssueConfirmed: false }))).toMatchObject({
      reason: "ISSUE_LINK_MISSING",
    });
  });

  describe("stale evidence", () => {
    it("refuses a review made on an older head", () => {
      expect(evaluateMerge(taskPr({ review: review({ headSha: OTHER }) }))).toMatchObject({
        allowed: false,
        reason: "STALE_REVISION",
      });
    });

    it("refuses when the base moved after the review", () => {
      expect(evaluateMerge(taskPr({ review: review({ baseSha: OTHER }) }))).toMatchObject({
        reason: "STALE_REVISION",
      });
    });

    it("refuses when the PR head is not the reviewed SHA the merge was asked for", () => {
      // A push after the review: the review and the merge guard both name the old head.
      const decision = evaluateMerge(
        taskPr({ expectedHeadSha: OTHER, review: review({ headSha: OTHER }) }),
      );
      expect(decision).toMatchObject({ allowed: false, reason: "HEAD_MOVED" });
      expect(decision.allowed ? [] : decision.reasons).toContain("STALE_REVISION");
    });

    it("ignores a passing check reported for an older head", () => {
      const checks = [
        { name: "ci", headSha: OTHER, status: "passed" as const },
        { name: "architecture", headSha: HEAD, status: "passed" as const },
      ];
      expect(evaluateMerge(taskPr({ checks }))).toMatchObject({
        reason: "REQUIRED_CHECK_MISSING",
      });
    });
  });

  describe("review", () => {
    it("refuses when there is no review result", () => {
      expect(evaluateMerge(taskPr({ review: undefined }))).toMatchObject({
        reason: "REVIEW_MISSING",
      });
    });

    it("refuses a review that did not pass", () => {
      expect(evaluateMerge(taskPr({ review: review({ passed: false }) }))).toMatchObject({
        reason: "REVIEW_NOT_PASSED",
      });
    });

    it("refuses a review by the run that wrote the change", () => {
      expect(
        evaluateMerge(taskPr({ review: review({ reviewerRunId: "run-impl" }) })),
      ).toMatchObject({ reason: "REVIEW_NOT_INDEPENDENT" });
    });

    it("refuses a review by the implementing agent, even from another run", () => {
      expect(
        evaluateMerge(taskPr({ review: review({ reviewerAgentId: "agent-impl" }) })),
      ).toMatchObject({ reason: "REVIEW_NOT_INDEPENDENT" });
    });

    it("refuses a review whose reviewer identity is blank", () => {
      expect(evaluateMerge(taskPr({ review: review({ reviewerAgentId: " " }) }))).toMatchObject({
        reason: "REVIEW_NOT_INDEPENDENT",
      });
    });
  });

  describe("acceptance-criteria verdict lines", () => {
    const withLines = (text: string, count = 2) =>
      evaluateMerge(
        taskPr({
          review: review({ acLines: parseAcReviewLines(text) }),
          acceptanceCriteriaCount: count,
        }),
      );

    it("refuses when a criterion has no line", () => {
      expect(withLines("AC-1: met — unit test")).toMatchObject({ reason: "AC_LINE_MISSING" });
    });

    it("refuses a `not met` line", () => {
      expect(withLines("AC-1: met — a\nAC-2: not met — no e2e test")).toMatchObject({
        reason: "AC_NOT_MET",
      });
    });

    it("refuses two lines for one criterion, even when both say met", () => {
      expect(withLines("AC-1: met — a\nAC-1: met — b\nAC-2: met — c")).toMatchObject({
        reason: "AC_LINE_DUPLICATE",
      });
    });

    it("refuses a line for a criterion the Issue does not have", () => {
      expect(withLines("AC-1: met — a\nAC-2: met — b\nAC-3: met — c")).toMatchObject({
        reason: "AC_LINE_UNKNOWN",
      });
    });

    it("refuses a verdict line without evidence", () => {
      expect(withLines("AC-1: met\nAC-2: met — b")).toMatchObject({ reason: "AC_LINE_MALFORMED" });
    });

    it("refuses when the Issue has no top-level criteria to judge", () => {
      expect(withLines("", 0)).toMatchObject({ reason: "AC_CRITERIA_MISSING" });
    });
  });

  describe("checks", () => {
    it("refuses a pending required check and a failed one, with different codes", () => {
      const withStatus = (status: "pending" | "failed") =>
        taskPr({
          checks: [
            { name: "ci", headSha: HEAD, status },
            { name: "architecture", headSha: HEAD, status: "passed" },
          ],
        });
      expect(evaluateMerge(withStatus("pending"))).toMatchObject({ reason: "CHECKS_PENDING" });
      expect(evaluateMerge(withStatus("failed"))).toMatchObject({ reason: "CHECKS_FAILED" });
    });

    it("refuses a required check that never reported", () => {
      expect(evaluateMerge(taskPr({ checks: [] }))).toMatchObject({
        reason: "REQUIRED_CHECK_MISSING",
      });
    });

    it("ignores a failing check that is not required", () => {
      const checks = [
        ...taskPr().checks,
        { name: "optional-lint", headSha: HEAD, status: "failed" as const },
      ];
      expect(evaluateMerge(taskPr({ checks }))).toEqual({ allowed: true });
    });

    it("does not need checks when none are required", () => {
      expect(evaluateMerge(taskPr({ requiredChecks: [], checks: [] }))).toEqual({
        allowed: true,
      });
    });
  });

  it("refuses unresolved mandatory findings and a failed workflow gate", () => {
    expect(evaluateMerge(taskPr({ unresolvedMandatoryFindings: 1 }))).toMatchObject({
      reason: "FINDINGS_UNRESOLVED",
    });
    expect(evaluateMerge(taskPr({ workflowGatesPassed: false }))).toMatchObject({
      reason: "GATE_NOT_PASSED",
    });
  });

  it.each([
    ["clean", undefined],
    ["has_hooks", undefined],
    ["dirty", "MERGE_CONFLICT"],
    ["behind", "BASE_BEHIND"],
    ["draft", "PULL_REQUEST_DRAFT"],
    ["blocked", "MERGE_BLOCKED"],
    ["unstable", "MERGE_BLOCKED"],
    ["unknown", "MERGEABILITY_UNKNOWN"],
  ] as const)("maps GitHub mergeable state %s to %s", (mergeableState, reason) => {
    const decision = evaluateMerge(taskPr({ mergeableState }));
    expect(decision).toEqual(
      reason === undefined ? { allowed: true } : { allowed: false, reason, reasons: [reason] },
    );
  });

  describe("native approval (read from GitHub, never created)", () => {
    const approve = (
      overrides: Partial<NativeReviewObservation> = {},
    ): NativeReviewObservation => ({
      actor: "po",
      actorType: "User",
      state: "APPROVED",
      commitSha: HEAD,
      ...overrides,
    });
    const withNative = (reviews: NativeReviewObservation[], requiredCount = 1) =>
      evaluateMerge(
        taskPr({
          nativeApproval: {
            requiredCount,
            pullAuthor: "omi-bot",
            runtimeActors: ["omi-bot"],
            reviews,
          },
        }),
      );

    it("accepts a human approval on the current head when one is required", () => {
      expect(withNative([approve()])).toEqual({ allowed: true });
    });

    it("refuses when an approval is required and none exists", () => {
      expect(withNative([])).toMatchObject({ reason: "NATIVE_APPROVAL_MISSING" });
    });

    it("refuses an approval given on an older head", () => {
      expect(withNative([approve({ commitSha: OTHER })])).toMatchObject({
        reason: "NATIVE_APPROVAL_MISSING",
      });
    });

    it("does not count the runtime's own account, the author or a bot", () => {
      expect(withNative([approve({ actor: "OMI-BOT" })])).toMatchObject({
        reason: "NATIVE_APPROVAL_MISSING",
      });
      expect(
        evaluateMerge(
          taskPr({
            nativeApproval: {
              requiredCount: 1,
              pullAuthor: "dev",
              runtimeActors: [],
              reviews: [approve({ actor: "dev" })],
            },
          }),
        ),
      ).toMatchObject({ reason: "NATIVE_APPROVAL_MISSING" });
      expect(withNative([approve({ actor: "ci[bot]", actorType: "Bot" })])).toMatchObject({
        reason: "NATIVE_APPROVAL_MISSING",
      });
    });

    it("counts distinct reviewers, by their latest decisive review", () => {
      expect(withNative([approve(), approve({ actor: "PO" })], 2)).toMatchObject({
        reason: "NATIVE_APPROVAL_MISSING",
      });
      expect(withNative([approve(), approve({ state: "DISMISSED" })])).toMatchObject({
        reason: "NATIVE_APPROVAL_MISSING",
      });
      // A later comment does not withdraw an approval, as on GitHub.
      expect(withNative([approve(), approve({ state: "COMMENTED", commitSha: OTHER })])).toEqual({
        allowed: true,
      });
    });

    it("refuses outstanding requested changes even when no approval is required", () => {
      expect(withNative([approve({ actor: "qa", state: "CHANGES_REQUESTED" })], 0)).toMatchObject({
        reason: "NATIVE_CHANGES_REQUESTED",
      });
    });
  });

  it("requires the merge lock, because merges are serialised", () => {
    expect(evaluateMerge(taskPr({ mergeLockHeld: false }))).toMatchObject({
      reason: "MERGE_LOCK_NOT_HELD",
    });
  });

  describe("approvals", () => {
    it("refuses a release approval and expectation for another PR with the same head", () => {
      expect(
        evaluateMerge(
          taskPr({
            kind: "release",
            pullRequestId: "pr-2",
            requiredApprovals: [releaseApproval(poApproval(HEAD))],
          }),
        ),
      ).toMatchObject({ allowed: false, reason: "APPROVAL_REQUIRED" });
    });
    it("refuses a required approval that is missing or rejected", () => {
      expect(
        evaluateMerge(taskPr({ requiredApprovals: [releaseApproval(undefined)] })),
      ).toMatchObject({ reason: "APPROVAL_REQUIRED" });
    });

    it("refuses an approval made for an older head even though GitHub may still show it", () => {
      expect(
        evaluateMerge(taskPr({ requiredApprovals: [releaseApproval(poApproval(OTHER))] })),
      ).toMatchObject({ reason: "APPROVAL_REQUIRED" });
    });

    it("accepts an approval on the current head", () => {
      expect(
        evaluateMerge(taskPr({ requiredApprovals: [releaseApproval(poApproval(HEAD))] })),
      ).toEqual({ allowed: true });
    });

    it("refuses a release merge whose approval was made for an older head", () => {
      const oldHead = { ...releaseApproval(poApproval(OTHER)) };
      const forOldHead = {
        approval: oldHead.approval,
        expected: {
          ...oldHead.expected,
          subject: { kind: "release", pullRequestId: "pr-1", headSha: OTHER } as const,
        },
      };
      // The caller's expectation names the old head, so the approval matches itself; the policy
      // must still compare with the head that is on the remote now.
      expect(
        evaluateMerge(taskPr({ kind: "release", requiredApprovals: [forOldHead] })),
      ).toMatchObject({ allowed: false, reason: "APPROVAL_REQUIRED" });
    });

    it("refuses a release merge that only has a business approval", () => {
      const business = {
        approval: {
          id: "ap-b",
          subject: { kind: "business", baselineHash: "h", scopeIds: ["s"] },
          decision: "approved",
          actor: "po",
          source: "github-actor",
          decidedAt: 1,
        } as const satisfies Approval,
        expected: {
          subject: { kind: "business", baselineHash: "h", scopeIds: ["s"] } as const,
          allowedActors: ["po"],
          now: 10,
        },
      };
      expect(
        evaluateMerge(taskPr({ kind: "release", requiredApprovals: [business] })),
      ).toMatchObject({
        allowed: false,
        reason: "APPROVAL_REQUIRED",
      });
    });

    it("never allows a release PR without any approval requirement attached", () => {
      expect(evaluateMerge(taskPr({ kind: "release", requiredApprovals: [] }))).toMatchObject({
        reason: "APPROVAL_REQUIRED",
      });
      expect(
        evaluateMerge(
          taskPr({ kind: "release", requiredApprovals: [releaseApproval(poApproval(HEAD))] }),
        ),
      ).toEqual({ allowed: true });
    });
  });

  describe("evaluateMergeConfirmation", () => {
    const MERGE = "d".repeat(40);
    const confirmed = (
      overrides: Partial<MergeConfirmationInputs> = {},
    ): MergeConfirmationInputs => ({
      merged: true,
      targetBranch: "develop",
      expectedTargetBranch: "develop",
      mergedHeadSha: HEAD,
      expectedHeadSha: HEAD,
      mergeCommitSha: MERGE,
      mergeCommitParents: [BASE, HEAD],
      mergeCommitOnTarget: true,
      ...overrides,
    });

    it("confirms a merge commit of the reviewed head that is on the target branch", () => {
      expect(evaluateMergeConfirmation(confirmed())).toEqual({ allowed: true });
    });

    it("does not trust the merge call: the remote must show the PR merged", () => {
      expect(evaluateMergeConfirmation(confirmed({ merged: false }))).toMatchObject({
        reason: "REMOTE_NOT_MERGED",
      });
    });

    it("refuses a PR merged at another head or into another branch", () => {
      expect(evaluateMergeConfirmation(confirmed({ mergedHeadSha: OTHER }))).toMatchObject({
        reason: "MERGED_AT_OTHER_HEAD",
      });
      expect(evaluateMergeConfirmation(confirmed({ targetBranch: "main" }))).toMatchObject({
        reason: "WRONG_TARGET_BRANCH",
      });
    });

    it("refuses a missing, unrelated or unreachable merge commit", () => {
      expect(evaluateMergeConfirmation(confirmed({ mergeCommitSha: null }))).toMatchObject({
        reason: "MERGE_COMMIT_MISSING",
      });
      expect(
        evaluateMergeConfirmation(confirmed({ mergeCommitParents: [BASE, OTHER] })),
      ).toMatchObject({ reason: "MERGE_COMMIT_MISMATCH" });
      expect(evaluateMergeConfirmation(confirmed({ mergeCommitOnTarget: false }))).toMatchObject({
        reason: "MERGE_COMMIT_NOT_ON_TARGET",
      });
    });
  });

  describe("evaluateIssueClose", () => {
    const close = (overrides: Partial<IssueCloseInputs> = {}): IssueCloseInputs => ({
      merged: true,
      mergedHeadSha: HEAD,
      review: review({ baseSha: OTHER }),
      acceptanceCriteriaCount: 2,
      authorRunIds: ["run-impl"],
      authorAgentIds: ["agent-impl"],
      ...overrides,
    });

    it("allows ticking and closing from the PASS on the merged head; the base may have moved", () => {
      expect(evaluateIssueClose(close())).toEqual({ allowed: true });
    });

    it("refuses before the merge is confirmed", () => {
      expect(evaluateIssueClose(close({ merged: false }))).toMatchObject({ reason: "NOT_MERGED" });
    });

    it("refuses a PASS on another head than the merged one", () => {
      expect(evaluateIssueClose(close({ mergedHeadSha: OTHER }))).toMatchObject({
        reason: "STALE_REVISION",
      });
    });

    it("refuses a missing line or a `not met`, so nothing is ticked", () => {
      const lines = (text: string) => review({ acLines: parseAcReviewLines(text) });
      expect(evaluateIssueClose(close({ review: lines("AC-1: met — a") }))).toMatchObject({
        reason: "AC_LINE_MISSING",
      });
      expect(
        evaluateIssueClose(close({ review: lines("AC-1: met — a\nAC-2: not met — b") })),
      ).toMatchObject({ reason: "AC_NOT_MET" });
    });

    it("refuses without an independent passing review", () => {
      expect(evaluateIssueClose(close({ review: undefined }))).toMatchObject({
        reason: "REVIEW_MISSING",
      });
      expect(evaluateIssueClose(close({ review: review({ passed: false }) }))).toMatchObject({
        reason: "REVIEW_NOT_PASSED",
      });
      expect(
        evaluateIssueClose(close({ review: review({ reviewerRunId: "run-impl" }) })),
      ).toMatchObject({ reason: "REVIEW_NOT_INDEPENDENT" });
    });
  });

  it("returns every failed reason in priority order", () => {
    const decision = evaluateMerge(
      taskPr({
        targetBranch: "main",
        review: undefined,
        checks: [],
        mergeLockHeld: false,
      }),
    );
    expect(decision).toEqual({
      allowed: false,
      reason: "WRONG_TARGET_BRANCH",
      reasons: [
        "WRONG_TARGET_BRANCH",
        "REVIEW_MISSING",
        "REQUIRED_CHECK_MISSING",
        "MERGE_LOCK_NOT_HELD",
      ],
    });
  });
});
