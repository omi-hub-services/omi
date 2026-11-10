import { describe, expect, it } from "vitest";
import type { Approval } from "../../../../src/domain/approvals/approval.ts";
import { evaluateMerge } from "../../../../src/domain/delivery/merge-policy.ts";
import type { MergeInputs } from "../../../../src/domain/delivery/merge-policy.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);

const taskPr = (overrides: Partial<MergeInputs> = {}): MergeInputs => ({
  kind: "task",
  targetBranch: "develop",
  expectedTargetBranch: "develop",
  currentHeadSha: HEAD,
  currentBaseSha: BASE,
  linkedIssueConfirmed: true,
  hasConflicts: false,
  review: { reviewerRunId: "run-review", headSha: HEAD, baseSha: BASE, passed: true },
  authorRunIds: ["run-impl"],
  requiredChecks: ["ci", "architecture"],
  checks: [
    { name: "ci", headSha: HEAD, status: "passed" },
    { name: "architecture", headSha: HEAD, status: "passed" },
  ],
  unresolvedMandatoryFindings: 0,
  workflowGatesPassed: true,
  requiredApprovals: [],
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
      const review = { reviewerRunId: "r", headSha: OTHER, baseSha: BASE, passed: true };
      expect(evaluateMerge(taskPr({ review }))).toMatchObject({
        allowed: false,
        reason: "STALE_REVISION",
      });
    });

    it("refuses when the base moved after the review", () => {
      const review = { reviewerRunId: "r", headSha: HEAD, baseSha: OTHER, passed: true };
      expect(evaluateMerge(taskPr({ review }))).toMatchObject({ reason: "STALE_REVISION" });
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
      const review = { reviewerRunId: "r", headSha: HEAD, baseSha: BASE, passed: false };
      expect(evaluateMerge(taskPr({ review }))).toMatchObject({ reason: "REVIEW_NOT_PASSED" });
    });

    it("refuses a review by the run that wrote the change", () => {
      const review = { reviewerRunId: "run-impl", headSha: HEAD, baseSha: BASE, passed: true };
      expect(evaluateMerge(taskPr({ review }))).toMatchObject({
        reason: "REVIEW_NOT_INDEPENDENT",
      });
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

  it("refuses unresolved mandatory findings, a failed workflow gate and conflicts", () => {
    expect(evaluateMerge(taskPr({ unresolvedMandatoryFindings: 1 }))).toMatchObject({
      reason: "FINDINGS_UNRESOLVED",
    });
    expect(evaluateMerge(taskPr({ workflowGatesPassed: false }))).toMatchObject({
      reason: "GATE_NOT_PASSED",
    });
    expect(evaluateMerge(taskPr({ hasConflicts: true }))).toMatchObject({
      reason: "MERGE_CONFLICT",
    });
  });

  it("requires the merge lock, because merges are serialised", () => {
    expect(evaluateMerge(taskPr({ mergeLockHeld: false }))).toMatchObject({
      reason: "MERGE_LOCK_NOT_HELD",
    });
  });

  describe("approvals", () => {
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
