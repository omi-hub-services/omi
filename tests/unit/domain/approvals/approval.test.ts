import { describe, expect, it } from "vitest";
import {
  APPROVAL_RULES,
  APPROVAL_STATUSES,
  transitionApproval,
} from "../../../../src/domain/approvals/approval.ts";
import type {
  Approval,
  ApprovalEvent,
  ApprovalSubject,
} from "../../../../src/domain/approvals/approval.ts";
import { evaluateApproval } from "../../../../src/domain/approvals/approval-policy.ts";
import type { ApprovalExpectation } from "../../../../src/domain/approvals/approval-policy.ts";

const NOW = 5_000;
const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);

const release = (headSha: string): ApprovalSubject => ({
  kind: "release",
  pullRequestId: "pr-9",
  headSha,
});

const approved = (subject: ApprovalSubject, overrides: Partial<Approval> = {}): Approval => ({
  id: "ap-1",
  subject,
  decision: "approved",
  actor: "po",
  source: "github-actor",
  decidedAt: 1,
  ...overrides,
});

const expecting = (
  subject: ApprovalSubject,
  overrides: Partial<ApprovalExpectation> = {},
): ApprovalExpectation => ({
  subject,
  allowedActors: ["po"],
  authorActor: "agent",
  now: NOW,
  ...overrides,
});

describe("evaluateApproval", () => {
  it("accepts an approval for the exact subject by an allowlisted actor", () => {
    expect(evaluateApproval(approved(release(HEAD)), expecting(release(HEAD)))).toEqual({
      allowed: true,
    });
  });

  it("refuses when there is no approval, and when it was a rejection", () => {
    expect(evaluateApproval(undefined, expecting(release(HEAD)))).toMatchObject({
      reason: "NO_APPROVAL",
    });
    expect(
      evaluateApproval(approved(release(HEAD), { decision: "rejected" }), expecting(release(HEAD))),
    ).toMatchObject({ reason: "APPROVAL_REJECTED" });
  });

  it("does not let a release approval survive a push: a new head is a stale revision", () => {
    expect(evaluateApproval(approved(release(HEAD)), expecting(release(NEW_HEAD)))).toMatchObject({
      allowed: false,
      reason: "STALE_REVISION",
    });
  });

  it("refuses an approval for another PR", () => {
    const other: ApprovalSubject = { kind: "release", pullRequestId: "pr-10", headSha: HEAD };
    expect(evaluateApproval(approved(other), expecting(release(HEAD)))).toMatchObject({
      reason: "SUBJECT_MISMATCH",
    });
  });

  it("never lets a release approval stand in for a deploy approval", () => {
    const deploy: ApprovalSubject = {
      kind: "deploy",
      artifactDigest: "sha256:1",
      environment: "production",
    };
    expect(evaluateApproval(approved(release(HEAD)), expecting(deploy))).toMatchObject({
      reason: "WRONG_KIND",
    });
  });

  describe("deploy", () => {
    const deploy = (artifactDigest: string, environment = "production"): ApprovalSubject => ({
      kind: "deploy",
      artifactDigest,
      environment,
    });

    it("binds to the artifact digest and the environment", () => {
      expect(
        evaluateApproval(approved(deploy("sha256:1")), expecting(deploy("sha256:2"))),
      ).toMatchObject({ reason: "STALE_REVISION" });
      expect(
        evaluateApproval(approved(deploy("sha256:1")), expecting(deploy("sha256:1", "staging"))),
      ).toMatchObject({ reason: "SUBJECT_MISMATCH" });
      expect(evaluateApproval(approved(deploy("sha256:1")), expecting(deploy("sha256:1")))).toEqual(
        { allowed: true },
      );
    });
  });

  describe("business baseline", () => {
    const business = (baselineHash: string, scopeIds: string[]): ApprovalSubject => ({
      kind: "business",
      baselineHash,
      scopeIds,
    });

    it("stays valid while baseline and scope are unchanged", () => {
      expect(
        evaluateApproval(approved(business("h1", ["s1", "s2"])), expecting(business("h1", ["s1"]))),
      ).toEqual({ allowed: true });
    });

    it("is stale when the baseline hash changed, and short when the scope grew", () => {
      expect(
        evaluateApproval(approved(business("h1", ["s1"])), expecting(business("h2", ["s1"]))),
      ).toMatchObject({ reason: "STALE_REVISION" });
      expect(
        evaluateApproval(approved(business("h1", ["s1"])), expecting(business("h1", ["s1", "s2"]))),
      ).toMatchObject({ reason: "SCOPE_NOT_COVERED" });
    });
  });

  it("refuses an expired approval, with the boundary at expiresAt", () => {
    const withExpiry = (expiresAt: number) =>
      evaluateApproval(approved(release(HEAD), { expiresAt }), expecting(release(HEAD)));
    expect(withExpiry(NOW)).toMatchObject({ reason: "EXPIRED" });
    expect(withExpiry(NOW + 1)).toEqual({ allowed: true });
  });

  it("refuses the wrong actor and the author approving their own change", () => {
    expect(
      evaluateApproval(approved(release(HEAD), { actor: "mallory" }), expecting(release(HEAD))),
    ).toMatchObject({ reason: "ACTOR_NOT_ALLOWED" });
    expect(
      evaluateApproval(
        approved(release(HEAD), { actor: "agent" }),
        expecting(release(HEAD), { allowedActors: ["po", "agent"] }),
      ),
    ).toMatchObject({ allowed: false, reason: "SELF_APPROVAL" });
  });

  it("needs an evidence reference for a conversational approval", () => {
    const conversational = approved(release(HEAD), { source: "po-conversation" });
    expect(evaluateApproval(conversational, expecting(release(HEAD)))).toMatchObject({
      reason: "EVIDENCE_MISSING",
    });
    expect(
      evaluateApproval(
        approved(release(HEAD), { source: "po-conversation", evidenceRef: "msg-42" }),
        expecting(release(HEAD)),
      ),
    ).toEqual({ allowed: true });
  });

  it("reports every failure, most important first", () => {
    const decision = evaluateApproval(
      approved(release(HEAD), { actor: "mallory", expiresAt: 1 }),
      expecting(release(NEW_HEAD)),
    );
    expect(decision).toEqual({
      allowed: false,
      reason: "STALE_REVISION",
      reasons: ["STALE_REVISION", "EXPIRED", "ACTOR_NOT_ALLOWED"],
    });
  });
});

describe("approval lifecycle", () => {
  const events = {
    approve: {
      type: "approve",
      actorAllowed: true,
      actorIsAuthor: false,
      sourceAuthenticated: true,
      subjectCurrent: true,
    },
    reject: {
      type: "reject",
      actorAllowed: true,
      sourceAuthenticated: true,
      reason: "out of scope",
    },
    expire: { type: "expire", now: 10, expiresAt: 10 },
    invalidate: { type: "invalidate", subjectChanged: true },
  } satisfies Record<ApprovalEvent["type"], ApprovalEvent>;

  it("accepts exactly the declared transitions", () => {
    for (const from of APPROVAL_STATUSES) {
      for (const event of Object.values(events)) {
        const declared = APPROVAL_RULES.find((r) => r.from === from && r.event === event.type);
        const outcome = transitionApproval(from, event);
        if (declared === undefined) {
          expect(outcome, `${from} + ${event.type}`).toMatchObject({
            ok: false,
            reason: "TRANSITION_NOT_ALLOWED",
          });
        } else {
          expect(outcome, `${from} + ${event.type}`).toEqual({ ok: true, from, to: declared.to });
        }
      }
    }
  });

  it("allows no change after rejected, expired or invalidated", () => {
    for (const from of ["rejected", "expired", "invalidated"] as const) {
      expect(APPROVAL_RULES.filter((r) => r.from === from)).toEqual([]);
    }
  });

  it("approves only from an authenticated, allowlisted, non-author source on the current subject", () => {
    const base = events.approve;
    expect(transitionApproval("pending", { ...base, sourceAuthenticated: false })).toMatchObject({
      reason: "SOURCE_NOT_AUTHENTICATED",
    });
    expect(transitionApproval("pending", { ...base, actorAllowed: false })).toMatchObject({
      reason: "ACTOR_NOT_ALLOWED",
    });
    expect(transitionApproval("pending", { ...base, actorIsAuthor: true })).toMatchObject({
      reason: "SELF_APPROVAL",
    });
    expect(transitionApproval("pending", { ...base, subjectCurrent: false })).toMatchObject({
      reason: "SUBJECT_STALE",
    });
    expect(transitionApproval("pending", base)).toMatchObject({ to: "approved" });
  });

  it("records a rejection only with a reason from an allowed actor", () => {
    expect(transitionApproval("pending", { ...events.reject, reason: " " })).toMatchObject({
      reason: "REJECTION_REASON_MISSING",
    });
    expect(transitionApproval("pending", { ...events.reject, actorAllowed: false })).toMatchObject({
      reason: "ACTOR_NOT_ALLOWED",
    });
    expect(transitionApproval("pending", events.reject)).toMatchObject({ to: "rejected" });
  });

  it("expires only at or after expiresAt, and invalidates only when the subject changed", () => {
    expect(transitionApproval("approved", { type: "expire", now: 9, expiresAt: 10 })).toMatchObject(
      { reason: "NOT_EXPIRED_YET" },
    );
    expect(transitionApproval("approved", events.expire)).toMatchObject({ to: "expired" });
    expect(
      transitionApproval("approved", { type: "invalidate", subjectChanged: false }),
    ).toMatchObject({ reason: "SUBJECT_UNCHANGED" });
    expect(transitionApproval("approved", events.invalidate)).toMatchObject({
      to: "invalidated",
    });
  });
});
