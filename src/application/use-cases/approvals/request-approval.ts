import { approvalSubjectHash } from "../../../domain/approvals/approval.js";
import type { ApprovalRequest } from "../../../domain/approvals/approval.js";
import { approvalSubjectSchema, requestApprovalSchema } from "../../contracts/approval.js";
import type { ApprovalSubjectReader } from "../../ports/approval-store.js";
import type { StateCommitResult, StateUnitOfWork } from "../../ports/state-unit-of-work.js";

export interface RequestApprovalDependencies {
  readonly subjects: ApprovalSubjectReader;
  readonly unitOfWork: StateUnitOfWork;
  readonly now: () => number;
  readonly nextId: () => string;
}

export type RequestApprovalResult =
  | { readonly ok: true; readonly request: ApprovalRequest }
  | { readonly ok: false; readonly reason: "INVALID_INPUT" | "SUBJECT_NOT_FOUND" | "EXPIRED" }
  | Extract<StateCommitResult, { ok: false }>;

export function requestApproval(
  deps: RequestApprovalDependencies,
  input: unknown,
): RequestApprovalResult {
  const parsed = requestApprovalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const command = parsed.data;
  const subject = approvalSubjectSchema.safeParse(
    deps.subjects.read(command.subjectId, command.kind),
  );
  if (!subject.success || subject.data.kind !== command.kind)
    return { ok: false, reason: "SUBJECT_NOT_FOUND" };
  const now = deps.now();
  if (command.expiresAt !== undefined && command.expiresAt <= now)
    return { ok: false, reason: "EXPIRED" };
  const request: ApprovalRequest = {
    id: deps.nextId(),
    subjectId: command.subjectId,
    subject: subject.data,
    subjectHash: approvalSubjectHash(subject.data),
    status: "pending",
    version: 0,
    requestedAt: now,
    ...(command.runId === undefined ? {} : { runId: command.runId }),
    ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
  };
  const committed = deps.unitOfWork.commit({
    target: { kind: "approval_request", request },
    at: new Date(now).toISOString(),
    event: {
      eventId: deps.nextId(),
      kind: "approval.requested",
      subject: request.id,
      correlationId: request.id,
      payload: JSON.stringify(request),
      ...(request.runId === undefined ? {} : { runId: request.runId }),
    },
  });
  return committed.ok ? { ok: true, request } : committed;
}
