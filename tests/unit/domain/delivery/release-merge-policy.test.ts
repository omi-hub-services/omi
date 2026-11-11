import { describe, expect, it } from "vitest";
import { evaluateReleaseMerge } from "../../../../src/domain/delivery/release-policy.ts";
import type { ReleaseMergeInputs } from "../../../../src/domain/delivery/release-policy.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
function input(): ReleaseMergeInputs {
  return {
    headRef: "develop",
    baseRef: "main",
    open: true,
    expectedHeadSha: HEAD,
    currentHeadSha: HEAD,
    poActors: ["PO"],
    canMerge: true,
    mergeableState: "clean",
    requiredChecks: ["ci"],
    checks: [{ name: "ci", headSha: HEAD, status: "passed" }],
    nativeApproval: {
      requiredCount: 1,
      pullAuthor: "author",
      runtimeActors: ["runtime"],
      reviews: [{ actor: "po", actorType: "User", state: "APPROVED", commitSha: HEAD }],
    },
  };
}
function refuses(value: ReleaseMergeInputs, reason: string) {
  const result = evaluateReleaseMerge(value);
  expect(result.allowed).toBe(false);
  if (!result.allowed) expect(result.reasons).toContain(reason);
}

describe("release merge policy", () => {
  it("accepts the allowlisted native human PO on the exact head, case-insensitively", () => {
    expect(evaluateReleaseMerge(input())).toEqual({ allowed: true });
    expect(evaluateReleaseMerge({ ...input(), mergeableState: "has_hooks" })).toEqual({
      allowed: true,
    });
  });
  it.each([
    [{ headRef: "release/1" }, "WRONG_RELEASE_BRANCH_FLOW"],
    [{ baseRef: "develop" }, "WRONG_RELEASE_BRANCH_FLOW"],
    [{ open: false }, "PR_NOT_OPEN"],
    [{ expectedHeadSha: OLD }, "HEAD_MOVED"],
    [{ canMerge: false }, "MERGE_PERMISSION_DENIED"],
    [{ checks: [] }, "REQUIRED_CHECK_MISSING"],
    [{ checks: [{ name: "ci", headSha: OLD, status: "passed" }] }, "REQUIRED_CHECK_MISSING"],
    [{ checks: [{ name: "ci", headSha: HEAD, status: "pending" }] }, "CHECKS_PENDING"],
    [{ checks: [{ name: "ci", headSha: HEAD, status: "failed" }] }, "CHECKS_FAILED"],
    [{ mergeableState: "draft" }, "PULL_REQUEST_DRAFT"],
    [{ mergeableState: "dirty" }, "MERGE_CONFLICT"],
    [{ mergeableState: "behind" }, "BASE_BEHIND"],
    [{ mergeableState: "blocked" }, "MERGE_BLOCKED"],
    [{ mergeableState: "unstable" }, "MERGE_BLOCKED"],
    [{ mergeableState: "unknown" }, "MERGEABILITY_UNKNOWN"],
  ] as const)("refuses %j with %s", (patch, reason) => {
    refuses({ ...input(), ...patch }, reason);
  });

  it.each([
    [{ actor: "other" }, "PO_APPROVAL_MISSING"],
    [{ actorType: "Bot" }, "PO_APPROVAL_MISSING"],
    [{ state: "DISMISSED" }, "PO_APPROVAL_MISSING"],
    [{ state: "COMMENTED" }, "PO_APPROVAL_MISSING"],
    [{ state: "PENDING" }, "PO_APPROVAL_MISSING"],
    [{ state: "CHANGES_REQUESTED" }, "NATIVE_CHANGES_REQUESTED"],
    [{ commitSha: OLD }, "PO_APPROVAL_STALE"],
  ] as const)("refuses PO review %j with %s", (patch, reason) => {
    const value = input();
    refuses(
      {
        ...value,
        nativeApproval: {
          ...value.nativeApproval,
          reviews: [
            { actor: "po", actorType: "User", state: "APPROVED", commitSha: HEAD, ...patch },
          ],
        },
      },
      reason,
    );
  });

  it("refuses absent PO configuration or review, and shared author/runtime identities", () => {
    const value = input();
    refuses({ ...value, poActors: [] }, "PO_APPROVAL_MISSING");
    refuses(
      { ...value, nativeApproval: { ...value.nativeApproval, reviews: [] } },
      "PO_APPROVAL_MISSING",
    );
    refuses(
      { ...value, nativeApproval: { ...value.nativeApproval, pullAuthor: "PO" } },
      "PO_APPROVAL_MISSING",
    );
    refuses(
      { ...value, nativeApproval: { ...value.nativeApproval, runtimeActors: ["PO"] } },
      "PO_APPROVAL_MISSING",
    );
  });

  it("counts latest decisive review once; comments do not revoke it; rejection/dismissal do", () => {
    const value = input();
    const review = value.nativeApproval.reviews[0];
    if (review === undefined) throw new Error("missing fixture");
    const withReview = (
      state: "COMMENTED" | "DISMISSED" | "CHANGES_REQUESTED",
    ): ReleaseMergeInputs => ({
      ...value,
      nativeApproval: {
        ...value.nativeApproval,
        reviews: [review, { ...review, actor: "PO", state }],
      },
    });
    expect(evaluateReleaseMerge(withReview("COMMENTED"))).toEqual({ allowed: true });
    refuses(withReview("DISMISSED"), "PO_APPROVAL_MISSING");
    refuses(withReview("CHANGES_REQUESTED"), "PO_APPROVAL_MISSING");
    refuses(
      {
        ...value,
        nativeApproval: {
          ...value.nativeApproval,
          requiredCount: 2,
          reviews: [review, { ...review, actor: "PO" }],
        },
      },
      "NATIVE_APPROVAL_MISSING",
    );
  });

  it("requires the PO even when other humans satisfy the native count", () => {
    const value = input();
    refuses(
      {
        ...value,
        nativeApproval: {
          ...value.nativeApproval,
          reviews: [{ actor: "reviewer", actorType: "User", state: "APPROVED", commitSha: HEAD }],
        },
      },
      "PO_APPROVAL_MISSING",
    );
  });
});
