import {
  evaluateApproval,
  isApprovalSubjectCurrent,
} from "../../domain/approvals/approval-policy.js";
import type { ApprovalStore, ApprovalSubjectReader } from "../ports/approval-store.js";
import type { ReworkRun } from "../ports/rework-run-reader.js";
import type { RunPlanStore } from "../ports/run-plan-store.js";
import type { PrMappingStore } from "../ports/pr-delivery.js";
import type { MergeDeliveryReader } from "../ports/merge-delivery.js";

/** Before a PR exists, workers share the runtime's GitHub credential (ADR-0026). */
export async function readReworkAuthor(
  deps: {
    readonly plans: Pick<RunPlanStore, "forRun">;
    readonly mappings: Pick<PrMappingStore, "get">;
    readonly reader: Pick<MergeDeliveryReader, "pull" | "authenticatedActor">;
  },
  runId: string,
): Promise<string | undefined> {
  const plan = deps.plans.forRun(runId);
  if (plan === undefined) return undefined;
  const mapping = deps.mappings.get(plan.projectId, plan.taskId);
  return mapping === undefined
    ? deps.reader.authenticatedActor()
    : (await deps.reader.pull(mapping.repository, mapping.prNumber)).author;
}

export interface ReworkApprovalDependencies {
  readonly store: ApprovalStore;
  readonly subjects: ApprovalSubjectReader;
  readonly now: () => number;
  readonly allowedGitHubActors: readonly string[];
  /** Trusted change author identity, never a command field. Unknown identities fail closed. */
  readonly authorActor: (run: ReworkRun) => Promise<string | undefined>;
}

/** Consume only an approval.decide record pinned to this run and current task baseline. */
export async function checkReworkApproval(
  deps: ReworkApprovalDependencies,
  run: ReworkRun,
  decisionId: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const authorActor = await deps.authorActor(run);
  if (authorActor === undefined || authorActor.trim() === "")
    return { ok: false, reason: "AUTHOR_UNKNOWN" };
  const request = deps.store.get(decisionId);
  if (request === undefined) return { ok: false, reason: "NO_APPROVAL" };
  if (request.status !== "approved") return { ok: false, reason: "APPROVAL_NOT_ACTIVE" };
  if (request.runId !== run.id || request.subjectId !== run.taskId)
    return { ok: false, reason: "SUBJECT_MISMATCH" };
  if (request.subject.kind !== "business") return { ok: false, reason: "WRONG_KIND" };
  if (!request.subject.scopeIds.includes(run.taskId))
    return { ok: false, reason: "SCOPE_NOT_COVERED" };
  if (run.rework.reopenDecisionIds.includes(decisionId))
    return { ok: false, reason: "APPROVAL_ALREADY_USED" };
  const decision = request.decision;
  if (
    decision === undefined ||
    decision.id !== request.id ||
    (decision.source !== "po-cli" && decision.source !== "github-actor") ||
    (decision.evidenceRef ?? "").trim() === ""
  )
    return { ok: false, reason: "SOURCE_NOT_AUTHENTICATED" };
  const current = deps.subjects.read(run.taskId, "business");
  if (current === undefined || !isApprovalSubjectCurrent(request.subject, current))
    return { ok: false, reason: "STALE_REVISION" };
  if (request.expiresAt !== undefined && deps.now() >= request.expiresAt)
    return { ok: false, reason: "EXPIRED" };
  const result = evaluateApproval(decision, {
    subject: current,
    // po-cli was authenticated by the runtime-owned TTY, not a GitHub allowlist.
    allowedActors: decision.source === "po-cli" ? [decision.actor] : deps.allowedGitHubActors,
    authorActor,
    now: deps.now(),
  });
  return result.allowed ? { ok: true } : { ok: false, reason: result.reasons[0] };
}
