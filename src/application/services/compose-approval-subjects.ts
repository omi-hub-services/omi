import type { ApprovalSubjectReader } from "../ports/approval-store.js";
import type { ApprovalKind } from "../../domain/approvals/approval.js";

/** Route each approval kind to the one reader that owns it; kinds without a reader fail closed. */
export function composeApprovalSubjects(
  readers: Partial<Record<ApprovalKind, ApprovalSubjectReader>>,
): ApprovalSubjectReader {
  return { read: (subjectId, kind) => readers[kind]?.read(subjectId, kind) };
}
