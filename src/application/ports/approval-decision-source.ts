import type { ApprovalRequest } from "../../domain/approvals/approval.js";
import type { RecordApprovalInput } from "../contracts/approval.js";

export interface VerifiedApprovalDecision {
  readonly approvalId: string;
  readonly subjectHash: string;
  readonly version: number;
  readonly decision: "approved" | "rejected";
  readonly actor: string;
  readonly source: "po-cli" | "github-actor";
  readonly evidenceRef: string;
}

export interface ApprovalDecisionSourceRefusal {
  readonly refused: true;
  readonly reason: "GITHUB_COMMENT_EDITED";
}

/**
 * Trusted I/O boundary, never implemented by parsing worker JSON. CLI must obtain a fresh
 * interactive confirmation; GitHub must read back the real actor and exact decision/revision.
 * Returning undefined refuses authentication; typed refusals preserve specific evidence failures.
 * Caller-supplied actor/source flags are not input.
 */
export interface ApprovalDecisionSource {
  verify(
    request: ApprovalRequest,
    input: RecordApprovalInput,
  ): Promise<VerifiedApprovalDecision | ApprovalDecisionSourceRefusal | undefined>;
}
