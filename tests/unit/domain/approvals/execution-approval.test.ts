import { describe, expect, it } from "vitest";
import {
  approvalSubjectHash,
  type ApprovalRequest,
  type ApprovalSubject,
} from "../../../../src/domain/approvals/approval.ts";
import {
  evaluateApproval,
  evaluateExecutionApprovals,
  isApprovalSubjectCurrent,
} from "../../../../src/domain/approvals/approval-policy.ts";

const business: ApprovalSubject = {
  kind: "business",
  baselineHash: "baseline",
  scopeIds: ["task"],
};
const cost: ApprovalSubject = { kind: "cost", estimateHash: "estimate", scopeIds: ["task"] };
const request = (subject: ApprovalSubject): ApprovalRequest => ({
  id: subject.kind,
  subjectId: "subject",
  subjectHash: approvalSubjectHash(subject),
  subject,
  status: "approved",
  version: 1,
  requestedAt: 0,
  decision: {
    id: subject.kind,
    subject,
    actor: "po",
    source: "po-cli",
    decidedAt: 1,
    decision: "approved",
  },
});
const expected = (subject: ApprovalSubject) => ({ subject, allowedActors: ["po"], now: 5 });

describe("execution approval gate", () => {
  it("requires both business and cost before execution, with no implicit cost approval", () => {
    expect(
      evaluateExecutionApprovals([
        { request: request(business), expected: expected(business) },
        { request: undefined, expected: expected(cost) },
      ]),
    ).toMatchObject({ allowed: false, reason: "NO_APPROVAL" });
    expect(
      evaluateExecutionApprovals([
        { request: request(business), expected: expected(business) },
        { request: request(cost), expected: expected(cost) },
      ]),
    ).toEqual({ allowed: true });
  });

  it("refuses pending, rejected, expired and stale requests even if an old decision remains", () => {
    for (const status of ["pending", "rejected", "expired", "invalidated"] as const) {
      expect(
        evaluateExecutionApprovals([
          { request: { ...request(cost), status }, expected: expected(cost) },
        ]),
      ).toMatchObject({ allowed: false, reason: "APPROVAL_NOT_ACTIVE" });
    }
  });

  it("rejects changed estimates, expanded scope, wrong actors and expiry at the boundary", () => {
    const approval = request(cost).decision;
    expect(
      evaluateApproval(approval, expected({ ...cost, estimateHash: "changed" })),
    ).toMatchObject({ reason: "STALE_REVISION" });
    expect(
      evaluateApproval(approval, expected({ ...cost, scopeIds: ["task", "extra"] })),
    ).toMatchObject({ reason: "SCOPE_NOT_COVERED" });
    expect(
      evaluateApproval(approval, { ...expected(cost), allowedActors: ["other"] }),
    ).toMatchObject({ reason: "ACTOR_NOT_ALLOWED" });
    expect(
      evaluateExecutionApprovals([
        {
          request: {
            ...request(cost),
            decision: {
              id: "cost",
              subject: cost,
              actor: "po",
              source: "po-cli",
              decidedAt: 1,
              decision: "approved",
              expiresAt: 5,
            },
          },
          expected: expected(cost),
        },
      ]),
    ).toMatchObject({ reason: "EXPIRED" });
  });

  it("keeps unchanged business/cost approvals valid without reasking for unrelated changes", () => {
    expect(
      evaluateExecutionApprovals([{ request: request(cost), expected: expected(cost) }]),
    ).toEqual({ allowed: true });
    expect(isApprovalSubjectCurrent(business, { ...business, scopeIds: ["task"] })).toBe(true);
    expect(isApprovalSubjectCurrent(cost, { ...cost, scopeIds: ["task", "extra"] })).toBe(false);
    expect(isApprovalSubjectCurrent(cost, business)).toBe(false);
    expect(approvalSubjectHash(cost)).toBe("estimate");
  });
});
