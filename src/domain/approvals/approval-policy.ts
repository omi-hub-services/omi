import { decide } from "../shared/decision.js";
import type { Decision } from "../shared/decision.js";
import type { Approval, ApprovalKind, ApprovalRequest, ApprovalSubject } from "./approval.js";

export type ApprovalInvalidReason =
  | "APPROVAL_NOT_ACTIVE"
  | "NO_APPROVAL"
  | "APPROVAL_REJECTED"
  | "WRONG_KIND"
  | "SUBJECT_MISMATCH"
  | "STALE_REVISION"
  | "SCOPE_NOT_COVERED"
  | "EXPIRED"
  | "ACTOR_NOT_ALLOWED"
  | "SELF_APPROVAL"
  | "EVIDENCE_MISSING";

/** What the use case needs approved right now, read from the current state of the world. */
export interface ApprovalExpectation {
  readonly subject: ApprovalSubject;
  /** Logins/ids the project allowlists as approvers. */
  readonly allowedActors: readonly string[];
  /** Author of the change; an author never approves their own change (AGENTS.md §7). */
  readonly authorActor?: string;
  readonly now: number;
}

/** Kinds where a conversational approval is not enough without evidence of the real message. */
const NEEDS_MESSAGE_EVIDENCE: readonly ApprovalKind[] = ["business", "cost", "release", "deploy"];

/**
 * Whether `approval` still authorises `expected`. Pure and total: a missing, rejected, stale,
 * expired, wrong-subject, wrong-kind or self-made approval each refuses with its own code.
 * Approval in text written by an agent is not representable: the source is closed to
 * `po-cli`, `github-actor` and `po-conversation` (the last needs an evidence reference).
 */
export function evaluateApproval(
  approval: Approval | undefined,
  expected: ApprovalExpectation,
): Decision<ApprovalInvalidReason> {
  if (approval === undefined) return decide(["NO_APPROVAL"]);
  if (approval.decision === "rejected") {
    return decide([
      expected.allowedActors.includes(approval.actor) ? "APPROVAL_REJECTED" : "ACTOR_NOT_ALLOWED",
    ]);
  }

  const refusals: ApprovalInvalidReason[] = [];
  if (approval.subject.kind !== expected.subject.kind) {
    refusals.push("WRONG_KIND");
  } else {
    refusals.push(...subjectRefusals(approval.subject, expected.subject));
  }
  if (approval.expiresAt !== undefined && expected.now >= approval.expiresAt) {
    refusals.push("EXPIRED");
  }
  if (!expected.allowedActors.includes(approval.actor)) {
    refusals.push("ACTOR_NOT_ALLOWED");
  }
  if (expected.authorActor !== undefined && approval.actor === expected.authorActor) {
    refusals.push("SELF_APPROVAL");
  }
  if (
    approval.source === "po-conversation" &&
    NEEDS_MESSAGE_EVIDENCE.includes(approval.subject.kind) &&
    (approval.evidenceRef ?? "").trim() === ""
  ) {
    refusals.push("EVIDENCE_MISSING");
  }
  return decide(refusals);
}

function subjectRefusals(
  approved: ApprovalSubject,
  expected: ApprovalSubject,
): ApprovalInvalidReason[] {
  switch (approved.kind) {
    case "business": {
      if (expected.kind !== "business") return ["WRONG_KIND"];
      const refusals: ApprovalInvalidReason[] = [];
      if (approved.baselineHash !== expected.baselineHash) refusals.push("STALE_REVISION");
      if (!expected.scopeIds.every((id) => approved.scopeIds.includes(id))) {
        refusals.push("SCOPE_NOT_COVERED");
      }
      return refusals;
    }
    case "cost": {
      if (expected.kind !== "cost") return ["WRONG_KIND"];
      const refusals: ApprovalInvalidReason[] = [];
      if (approved.estimateHash !== expected.estimateHash) refusals.push("STALE_REVISION");
      if (!expected.scopeIds.every((id) => approved.scopeIds.includes(id))) {
        refusals.push("SCOPE_NOT_COVERED");
      }
      return refusals;
    }
    case "release": {
      if (expected.kind !== "release") return ["WRONG_KIND"];
      if (approved.pullRequestId !== expected.pullRequestId) return ["SUBJECT_MISMATCH"];
      return approved.headSha === expected.headSha ? [] : ["STALE_REVISION"];
    }
    case "deploy": {
      if (expected.kind !== "deploy") return ["WRONG_KIND"];
      if (approved.environment !== expected.environment) return ["SUBJECT_MISMATCH"];
      return approved.artifactDigest === expected.artifactDigest ? [] : ["STALE_REVISION"];
    }
  }
}

/** Compare the complete pinned subject, including scope (order is immaterial). */
export function isApprovalSubjectCurrent(
  pinned: ApprovalSubject,
  current: ApprovalSubject,
): boolean {
  return (
    subjectRefusals(pinned, current).length === 0 && subjectRefusals(current, pinned).length === 0
  );
}

/** Mandatory business/cost requirements are supplied by the execution plan, not by the worker. */
export function evaluateExecutionApprovals(
  requirements: readonly {
    readonly request: ApprovalRequest | undefined;
    readonly expected: ApprovalExpectation;
  }[],
): Decision<ApprovalInvalidReason> {
  return decide(
    requirements.flatMap(({ request, expected }) => {
      if (request !== undefined && request.status !== "approved")
        return ["APPROVAL_NOT_ACTIVE" as const];
      const result = evaluateApproval(request?.decision, expected);
      return result.allowed ? [] : result.reasons;
    }),
  );
}
