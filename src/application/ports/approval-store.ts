import type { ApprovalRequest, ApprovalSubject } from "../../domain/approvals/approval.js";

export interface ApprovalStore {
  get(id: string): ApprovalRequest | undefined;
}

/** Authoritative baseline/estimate/PR/artifact reader, wired by the owning workflow. */
export interface ApprovalSubjectReader {
  read(subjectId: string, kind: ApprovalSubject["kind"]): ApprovalSubject | undefined;
}
