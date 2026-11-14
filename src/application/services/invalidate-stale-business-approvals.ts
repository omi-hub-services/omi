import { approvalSubjectSchema } from "../contracts/approval.js";
import { isApprovalSubjectCurrent } from "../../domain/approvals/approval-policy.js";
import { transitionApproval } from "../../domain/approvals/approval.js";
import type { ApprovalListReader, ApprovalSubjectReader } from "../ports/approval-store.js";
import type { StateUnitOfWork } from "../ports/state-unit-of-work.js";

/**
 * After a task's content hash changed, mark its open business approvals `invalidated` so
 * `approvals list` is truthful. The decision stays on the record (audit trail). Idempotent, and it
 * only touches requests the domain policy says no longer match the current snapshot. Dispatch does
 * not rely on this: it compares hashes itself (`resolveDispatchTask`), so a failed write here
 * leaves a stale label, never an open gate.
 */
export function invalidateStaleBusinessApprovals(
  deps: {
    readonly approvals: ApprovalListReader;
    readonly subjects: ApprovalSubjectReader;
    readonly unitOfWork: StateUnitOfWork;
    readonly now: () => number;
    readonly nextId: () => string;
  },
  taskId: string,
): number {
  const current = approvalSubjectSchema.safeParse(deps.subjects.read(taskId, "business"));
  if (!current.success) return 0;
  let invalidated = 0;
  for (const request of [...deps.approvals.list("pending"), ...deps.approvals.list("approved")]) {
    if (
      request.subject.kind !== "business" ||
      !request.subject.scopeIds.includes(taskId) ||
      isApprovalSubjectCurrent(request.subject, current.data)
    )
      continue;
    const transition = transitionApproval(request.status, {
      type: "invalidate",
      subjectChanged: true,
    });
    if (!transition.ok) continue;
    const updated = { ...request, status: transition.to, version: request.version + 1 };
    const eventId = deps.nextId();
    const committed = deps.unitOfWork.commit({
      target: {
        kind: "approval_decision",
        request: updated,
        expectedVersion: request.version,
      },
      at: new Date(deps.now()).toISOString(),
      event: {
        eventId,
        kind: "approval.invalidated",
        subject: request.id,
        correlationId: request.id,
        payload: JSON.stringify(updated),
        ...(request.runId === undefined ? {} : { runId: request.runId }),
      },
    });
    if (committed.ok) invalidated += 1;
  }
  return invalidated;
}
