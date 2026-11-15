import { transitionApproval } from "../../../domain/approvals/approval.js";
import type { ApprovalRequest, ApprovalRefusal } from "../../../domain/approvals/approval.js";
import {
  isApprovalSubjectCurrent,
  isApprovalActorAllowed,
} from "../../../domain/approvals/approval-policy.js";
import {
  approvalSubjectSchema,
  recordApprovalSchema,
  type RecordApprovalInput,
} from "../../contracts/approval.js";
import type {
  ApprovalDecisionSource,
  ApprovalDecisionSourceRefusal,
  VerifiedApprovalDecision,
} from "../../ports/approval-decision-source.js";
import type { ApprovalStore, ApprovalSubjectReader } from "../../ports/approval-store.js";
import type { StateCommitResult, StateUnitOfWork } from "../../ports/state-unit-of-work.js";

export interface RecordApprovalDependencies {
  readonly store: ApprovalStore;
  readonly subjects: ApprovalSubjectReader;
  readonly source: ApprovalDecisionSource;
  readonly allowedGitHubActors: readonly string[];
  readonly unitOfWork: StateUnitOfWork;
  readonly now: () => number;
  readonly nextId: () => string;
}
export type RecordApprovalResult =
  | { readonly ok: true; readonly request: ApprovalRequest }
  | {
      readonly ok: false;
      readonly reason:
        | ApprovalRefusal
        | ApprovalDecisionSourceRefusal["reason"]
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "STALE_VERSION"
        | "STALE_REVISION"
        | "EXPIRED"
        | "ACTOR_NOT_ALLOWED"
        | "TRANSITION_NOT_ALLOWED";
    }
  | Extract<StateCommitResult, { ok: false }>;

export async function recordApproval(
  deps: RecordApprovalDependencies,
  input: unknown,
): Promise<RecordApprovalResult> {
  const parsed = recordApprovalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const command = parsed.data;
  const request = deps.store.get(command.approvalId);
  if (request === undefined) return { ok: false, reason: "NOT_FOUND" };
  if (request.version !== command.expectedVersion) return { ok: false, reason: "STALE_VERSION" };
  if (request.status !== "pending") {
    // An existing approval can only expire/become stale; it never needs another human decision.
    if (request.status === "approved") return commitDecision(deps, request, command);
    return { ok: false, reason: "TRANSITION_NOT_ALLOWED" };
  }
  // Only the trusted adapter can attest actor/source and the specific decision it witnessed.
  const verified = await deps.source.verify(request, command);
  if (verified !== undefined && "refused" in verified) {
    return { ok: false, reason: verified.reason };
  }
  const expectedSource = command.pathway === "cli" ? "po-cli" : "github-actor";
  if (
    verified === undefined ||
    verified.source !== expectedSource ||
    verified.actor.trim() === "" ||
    verified.evidenceRef.trim() === "" ||
    verified.approvalId !== request.id ||
    verified.version !== request.version ||
    verified.subjectHash !== request.subjectHash ||
    verified.decision !== command.decision
  )
    return { ok: false, reason: "SOURCE_NOT_AUTHENTICATED" };
  if (
    verified.source === "github-actor" &&
    !isApprovalActorAllowed(verified.actor, verified.source, deps.allowedGitHubActors)
  ) {
    return { ok: false, reason: "ACTOR_NOT_ALLOWED" };
  }
  return commitDecision(deps, request, command, verified);
}

function commitDecision(
  deps: RecordApprovalDependencies,
  request: ApprovalRequest,
  command: RecordApprovalInput,
  verified?: VerifiedApprovalDecision,
): RecordApprovalResult {
  // Read after the asynchronous verification so a push during confirmation cannot be approved.
  const current = approvalSubjectSchema.safeParse(
    deps.subjects.read(request.subjectId, request.subject.kind),
  );
  const now = deps.now();
  const stale = !current.success || !isApprovalSubjectCurrent(request.subject, current.data);
  const expired = request.expiresAt !== undefined && now >= request.expiresAt;
  if (!stale && !expired && verified === undefined) {
    return { ok: false, reason: "TRANSITION_NOT_ALLOWED" };
  }
  const event = stale
    ? { type: "invalidate" as const, subjectChanged: true }
    : expired
      ? { type: "expire" as const, now, expiresAt: request.expiresAt ?? now }
      : command.decision === "approved"
        ? { type: "approve" as const, sourceAuthenticated: true, subjectCurrent: true }
        : { type: "reject" as const, sourceAuthenticated: true, reason: command.reason ?? "" };
  const transition = transitionApproval(request.status, event);
  if (!transition.ok) return { ok: false, reason: transition.reason };
  const updated: ApprovalRequest = {
    ...request,
    status: transition.to,
    version: request.version + 1,
    ...(stale || expired || verified === undefined
      ? {}
      : {
          decision: {
            id: request.id,
            subject: request.subject,
            decision: command.decision,
            actor: verified.actor,
            source: verified.source,
            evidenceRef: verified.evidenceRef,
            decidedAt: now,
            ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
            ...(command.reason === undefined ? {} : { reason: command.reason }),
          },
        }),
  };
  const committed = deps.unitOfWork.commit({
    target: {
      kind: "approval_decision",
      request: updated,
      expectedVersion: command.expectedVersion,
    },
    at: new Date(now).toISOString(),
    event: {
      eventId: deps.nextId(),
      kind: `approval.${updated.status}`,
      subject: request.id,
      correlationId: request.id,
      payload: JSON.stringify(updated),
      ...(request.runId === undefined ? {} : { runId: request.runId }),
    },
  });
  if (!committed.ok) return committed;
  if (stale) return { ok: false, reason: "STALE_REVISION" };
  if (expired) return { ok: false, reason: "EXPIRED" };
  return { ok: true, request: updated };
}
