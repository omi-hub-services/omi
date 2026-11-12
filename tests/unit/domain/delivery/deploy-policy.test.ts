import { describe, expect, it } from "vitest";
import type { Approval, ApprovalSubject } from "../../../../src/domain/approvals/approval.ts";
import { evaluateDeployApproval } from "../../../../src/domain/delivery/deploy-policy.ts";

const subject = {
  kind: "deploy",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  environment: "production",
} as const;
const expected = { subject, allowedActors: ["po"], authorActor: "agent", now: 5000 };
const approved = (overrides: Partial<Approval> = {}): Approval => ({
  id: "deploy-1",
  subject,
  decision: "approved",
  actor: "po",
  source: "github-actor",
  decidedAt: 1,
  ...overrides,
});

describe("evaluateDeployApproval", () => {
  it("allows a separate approval for the exact production artifact and environment", () => {
    expect(evaluateDeployApproval(approved(), expected)).toEqual({ allowed: true });
  });

  it.each([
    "latest",
    "app:latest",
    "sha256:abc",
    `sha256:${"g".repeat(64)}`,
    `sha256:${"a".repeat(64)}\n`,
    `sha256:${"a".repeat(65)}`,
    "",
  ])("refuses mutable or malformed artifact %j even when approved", (artifactDigest) => {
    const invalid = { ...subject, artifactDigest };
    expect(
      evaluateDeployApproval(approved({ subject: invalid }), { ...expected, subject: invalid }),
    ).toMatchObject({ allowed: false, reason: "INVALID_ARTIFACT_DIGEST" });
  });

  it("refuses a missing deploy approval", () => {
    expect(evaluateDeployApproval(undefined, expected)).toMatchObject({ reason: "NO_APPROVAL" });
  });

  it.each<ApprovalSubject>([
    { kind: "release", pullRequestId: "pr-1", headSha: "head" },
    { kind: "business", baselineHash: "baseline", scopeIds: [] },
    { kind: "cost", estimateHash: "estimate", scopeIds: [] },
  ])("refuses a $kind approval", (other) => {
    expect(evaluateDeployApproval(approved({ subject: other }), expected)).toMatchObject({
      reason: "WRONG_KIND",
    });
  });

  it("requires a new decision for a different artifact", () => {
    expect(
      evaluateDeployApproval(approved(), {
        ...expected,
        subject: { ...subject, artifactDigest: `sha256:${"b".repeat(64)}` },
      }),
    ).toMatchObject({ reason: "STALE_REVISION" });
  });

  it("requires a new decision for a different environment", () => {
    expect(
      evaluateDeployApproval(approved(), {
        ...expected,
        subject: { ...subject, environment: "staging" },
      }),
    ).toMatchObject({ reason: "SUBJECT_MISMATCH" });
  });

  it.each([
    ["APPROVAL_REJECTED", { decision: "rejected" }],
    ["EXPIRED", { expiresAt: 5000 }],
    ["ACTOR_NOT_ALLOWED", { actor: "stranger" }],
    ["SELF_APPROVAL", { actor: "agent" }],
    ["EVIDENCE_MISSING", { source: "po-conversation", evidenceRef: " " }],
  ] satisfies [string, Partial<Approval>][])("preserves shared refusal %s", (reason, overrides) => {
    expect(
      evaluateDeployApproval(approved(overrides), {
        ...expected,
        allowedActors: ["po", "agent"],
      }),
    ).toMatchObject({ allowed: false, reason });
  });

  it("reports all shared approval failures", () => {
    expect(
      evaluateDeployApproval(approved({ actor: "stranger", expiresAt: 5000 }), expected),
    ).toMatchObject({ reasons: ["EXPIRED", "ACTOR_NOT_ALLOWED"] });
  });
});
