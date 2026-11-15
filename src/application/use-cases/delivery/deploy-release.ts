import { evaluateDeployApproval } from "../../../domain/delivery/deploy-policy.js";
import { evaluateApproval } from "../../../domain/approvals/approval-policy.js";
import { approvalSubjectHash } from "../../../domain/approvals/approval.js";
import type { ApprovalSubject } from "../../../domain/approvals/approval.js";
import {
  deployEvidenceSchema,
  deployPipelineSchema,
  deployReleaseSchema,
  rollbackRunbookSchema,
} from "../../contracts/deploy-delivery.js";
import type { DeployEvidence } from "../../contracts/deploy-delivery.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type { ContentHasher } from "../../ports/content-hasher.js";
import type { ApprovalStore } from "../../ports/approval-store.js";
import type {
  DeployReader,
  DeployOperation,
  RollbackRunbookReader,
} from "../../ports/deploy-delivery.js";
import { DeliveryError } from "../../ports/pr-delivery.js";
import { deliverGithubOperation } from "../../services/deliver-github-operation.js";
import type { DeliverGithubOperationDeps } from "../../services/deliver-github-operation.js";
import type { z } from "zod";

export type DeployReleaseDeps = DeliverGithubOperationDeps & {
  readonly session: Pick<ProjectSession, "renew" | "record">;
  readonly hasher: ContentHasher;
  readonly pipeline: z.infer<typeof deployPipelineSchema>;
  readonly approvals: ApprovalStore;
  readonly deployments: DeployReader;
  readonly runbooks?: RollbackRunbookReader;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxPolls: number;
  readonly pollIntervalMs: number;
};
export type DeployReleaseResult =
  | { readonly status: "refused"; readonly reason: string }
  | {
      readonly status: "pending";
      readonly operationKey: string;
      readonly state: string;
      readonly notification?: string;
    }
  | { readonly status: "verified"; readonly evidence: DeployEvidence }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly evidence?: DeployEvidence;
      readonly notification: string;
    };

/** Serialized by the runtime writer. An unknown dispatch is reconciled, never blindly resent. */
export async function deployRelease(
  deps: DeployReleaseDeps,
  input: unknown,
): Promise<DeployReleaseResult> {
  const request = deployReleaseSchema.parse(input);
  if (!deps.session.renew()) return { status: "refused", reason: "PROJECT_LOCK_LOST" };
  const pipeline = deployPipelineSchema.parse(deps.pipeline);
  if (
    !Number.isInteger(deps.maxPolls) ||
    deps.maxPolls < 1 ||
    !Number.isFinite(deps.pollIntervalMs) ||
    deps.pollIntervalMs < 0
  )
    throw new DeliveryError("INVALID_POLL_POLICY");
  const subject = {
    kind: "deploy" as const,
    artifactDigest: request.artifactDigest,
    environment: request.environment,
  };
  const expectation = {
    subject,
    allowedActors: pipeline.allowedActors,
    authorActor: pipeline.authorActor,
    now: deps.now(),
  };
  const approval = deps.approvals.get(request.approvalId);
  const inactive = activeRefusal(approval, subject, deps.now());
  if (inactive !== undefined) return { status: "refused", reason: inactive };
  const decision = evaluateDeployApproval(approval?.decision, expectation);
  if (!decision.allowed) return { status: "refused", reason: decision.reason };
  let rollbackRunbook: DeployOperation["rollbackRunbook"];
  if (request.rollback !== undefined) {
    const runbook = rollbackRunbookSchema.safeParse(
      deps.runbooks?.read(request.rollback.runbookRef),
    );
    const approved = deps.approvals.get(request.rollback.approvalId);
    if (
      !runbook.success ||
      runbook.data.reference !== request.rollback.runbookRef ||
      runbook.data.repository !== request.repository ||
      runbook.data.environment !== request.environment ||
      runbook.data.previousDigest !== request.artifactDigest ||
      request.rollback.approvalId === request.approvalId
    )
      return { status: "refused", reason: "RUNBOOK_NOT_APPROVED" };
    const runbookSubject = {
      kind: "business" as const,
      baselineHash: runbook.data.revisionHash,
      scopeIds: [runbook.data.reference],
    };
    if (
      activeRefusal(approved, runbookSubject, deps.now()) !== undefined ||
      !evaluateApproval(approved?.decision, { ...expectation, subject: runbookSubject }).allowed
    )
      return { status: "refused", reason: "RUNBOOK_NOT_APPROVED" };
    rollbackRunbook = {
      reference: runbook.data.reference,
      revisionHash: runbook.data.revisionHash,
    };
  }
  const operationKey = `deploy:${deps.hasher.sha256(
    JSON.stringify([
      request.repository,
      request.environment,
      request.artifactDigest,
      request.approvalId,
      request.rollback?.runbookRef,
      request.rollback?.approvalId,
    ]),
  )}`;
  const operation: DeployOperation = {
    type: "deploy.dispatch",
    repo: request.repository,
    deploymentEnvironment: request.environment,
    artifactDigest: request.artifactDigest,
    workflow: pipeline.workflow,
    ref: pipeline.ref,
    workflowSha: pipeline.workflowSha,
    allowedActors: pipeline.allowedActors,
    authorActor: pipeline.authorActor,
    ...(rollbackRunbook === undefined ? {} : { rollbackRunbook }),
  };
  let outcome;
  try {
    outcome = await deliverGithubOperation(deps, operationKey, operation);
  } catch (error) {
    if (error instanceof DeliveryError && error.code === "OPERATION_KEY_CONFLICT")
      return { status: "refused", reason: error.code };
    throw error;
  }
  if (outcome.kind === "failed") return fail(outcome.code);
  if (outcome.kind === "pending") return { status: "pending", operationKey, state: outcome.state };
  const runId = Number(outcome.remoteIdentity);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new DeliveryError("INVALID_RUN_ID");
  for (let poll = 0; poll < deps.maxPolls; poll += 1) {
    if (!deps.session.renew())
      return { status: "pending", operationKey, state: "PROJECT_LOCK_LOST" };
    let evidence: DeployEvidence;
    try {
      evidence = deployEvidenceSchema.parse(
        await deps.deployments.evidence(operation, operationKey, runId),
      );
    } catch (error) {
      if (
        error instanceof DeliveryError &&
        ["DEPLOY_DIGEST_MISMATCH", "DEPLOY_RUN_MISMATCH", "DUPLICATE_DEPLOYMENTS"].includes(
          error.code,
        )
      )
        return fail(error.code);
      return { status: "pending", operationKey, state: "VERIFY_UNAVAILABLE" };
    }
    if (evidence.runId !== runId || evidence.artifactDigest !== request.artifactDigest)
      throw new DeliveryError("DEPLOY_IDENTITY_MISMATCH");
    if (evidence.status === "completed") {
      const success =
        evidence.conclusion === "success" &&
        evidence.deploymentStatus === "success" &&
        evidence.nativeApproved;
      deps.session.record("deploy.verified", { operationKey, ...evidence });
      return success
        ? { status: "verified", evidence }
        : fail("DEPLOY_VERIFICATION_FAILED", evidence);
    }
    const intent = deps.outbox.get(operationKey);
    if (intent !== undefined && deps.now() - Date.parse(intent.createdAt) >= 10 * 60_000)
      await notifyWaiting();
    if (poll + 1 < deps.maxPolls) await deps.sleep(deps.pollIntervalMs);
  }
  // No scheduler resumes deploy verification, so exhaustion must bring the PO back to it.
  const notification = await notifyWaiting();
  return {
    status: "pending",
    operationKey,
    state: "VERIFY_WAITING",
    notification: notification.kind,
  };

  async function notifyWaiting() {
    return deliverGithubOperation(deps, `${operationKey}:waiting:po`, {
      type: "issue.comment",
      repo: request.repository,
      issueNumber: pipeline.issueNumber,
      body: `${pipeline.allowedActors.map((actor) => `@${actor}`).join(" ")} Deploy verification waiting. Environment: ${request.environment}; artifact: ${request.artifactDigest}; run: ${String(runId)}. Waiting threshold or polling budget reached; please inspect the run and resume verification with the same request. No automatic rollback.`,
    });
  }

  async function fail(reason: string, evidence?: DeployEvidence): Promise<DeployReleaseResult> {
    const notification = await deliverGithubOperation(deps, `${operationKey}:po`, {
      type: "issue.comment",
      repo: request.repository,
      issueNumber: pipeline.issueNumber,
      body: `${pipeline.allowedActors.map((actor) => `@${actor}`).join(" ")} Deploy failed: ${reason}. Environment: ${request.environment}; artifact: ${request.artifactDigest}; run: ${String(evidence?.runId ?? "unavailable")}; conclusion: ${evidence?.conclusion ?? "unavailable"}; deployment status: ${evidence?.deploymentStatus ?? "unavailable"}. No automatic rollback. See runtime deploy evidence.`,
    });
    return {
      status: "failed",
      reason,
      ...(evidence === undefined ? {} : { evidence }),
      notification: notification.kind,
    };
  }
}

function activeRefusal(
  request: ReturnType<ApprovalStore["get"]>,
  subject: ApprovalSubject,
  now: number,
): string | undefined {
  if (request === undefined) return "NO_APPROVAL";
  if (request.status !== "approved") return "APPROVAL_NOT_ACTIVE";
  if (request.expiresAt !== undefined && now >= request.expiresAt) return "EXPIRED";
  if (
    request.subjectHash !== approvalSubjectHash(subject) ||
    request.subjectHash !== approvalSubjectHash(request.subject)
  )
    return "STALE_REVISION";
  return undefined;
}
