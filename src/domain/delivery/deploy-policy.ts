import { evaluateApproval } from "../approvals/approval-policy.js";
import type { ApprovalExpectation, ApprovalInvalidReason } from "../approvals/approval-policy.js";
import type { Approval, ApprovalSubject } from "../approvals/approval.js";
import { decide } from "../shared/decision.js";
import type { Decision } from "../shared/decision.js";

export type DeployApprovalRefusal = ApprovalInvalidReason | "INVALID_ARTIFACT_DIGEST";

/** A deploy needs its own decision for this immutable artifact in this environment. */
export function evaluateDeployApproval(
  approval: Approval | undefined,
  expected: ApprovalExpectation & {
    readonly subject: Extract<ApprovalSubject, { kind: "deploy" }>;
  },
): Decision<DeployApprovalRefusal> {
  const refusals: DeployApprovalRefusal[] = [];
  if (
    !/^sha256:[0-9a-f]{64}$/.test(expected.subject.artifactDigest) ||
    expected.subject.artifactDigest.length !== 71
  ) {
    refusals.push("INVALID_ARTIFACT_DIGEST");
  }
  const decision = evaluateApproval(approval, expected);
  if (!decision.allowed) refusals.push(...decision.reasons);
  return decide(refusals);
}
