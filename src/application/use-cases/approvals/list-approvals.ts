import { listApprovalsSchema } from "../../contracts/approval.js";
import type { ApprovalListReader } from "../../ports/approval-store.js";

/** Explicit projection keeps subject revisions and decision evidence inside the runtime. */
export function listApprovals(store: ApprovalListReader, input: unknown) {
  const { status } = listApprovalsSchema.parse(input);
  return {
    ok: true as const,
    approvals: store.list(status).map((request) => ({
      id: request.id,
      kind: request.subject.kind,
      subjectId: request.subjectId,
      status: request.status,
      version: request.version,
      requestedAt: request.requestedAt,
      decidedAt: request.decision?.decidedAt ?? null,
    })),
  };
}
