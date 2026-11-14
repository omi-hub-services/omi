import { approvalSubjectHash } from "../../../domain/approvals/approval.js";
import type { ApprovalRequest } from "../../../domain/approvals/approval.js";
import { evaluateDeployAllowlist } from "../../../domain/delivery/deploy-policy.js";
import { deployConfiguredSchema } from "../../contracts/deploy-delivery.js";
import type { DeployConfig, DeployTarget } from "../../contracts/project-config.js";
import type { ApprovalListReader, ApprovalStore } from "../../ports/approval-store.js";
import { deployRelease } from "./deploy-release.js";
import type { DeployReleaseDeps, DeployReleaseResult } from "./deploy-release.js";

export type DeployConfiguredReleaseDeps = Omit<DeployReleaseDeps, "pipeline" | "approvals"> & {
  readonly approvals: ApprovalStore & ApprovalListReader;
  /** `project.yaml` `deploy`; absent refuses every deploy. */
  readonly deploy: DeployConfig | undefined;
  readonly targets: readonly DeployTarget[] | undefined;
  /** The project's own `owner/name`; a caller never names it. */
  readonly repository: string;
};

/**
 * Deploys one `deploy_targets` entry. Pipeline, repository, environment and digest come from
 * project config and the approval id from the approval store, so the command carries only the
 * target id. Repeating it reconciles the same outbox intent: the operation key is derived from
 * the same repository, environment, digest and approval id, so no second dispatch is made.
 */
export async function deployConfiguredRelease(
  deps: DeployConfiguredReleaseDeps,
  input: unknown,
): Promise<DeployReleaseResult> {
  const { target: targetId } = deployConfiguredSchema.parse(input);
  const config = deps.deploy;
  if (config === undefined) return { status: "refused", reason: "DEPLOY_NOT_CONFIGURED" };
  const matches = (deps.targets ?? []).filter((candidate) => candidate.id === targetId);
  const [target] = matches;
  if (matches.length !== 1 || target === undefined)
    return { status: "refused", reason: "DEPLOY_TARGET_NOT_FOUND" };
  const allowed = evaluateDeployAllowlist(
    { repository: deps.repository, environment: target.target_environment },
    { repositories: config.allowed_repositories, environments: config.allowed_environments },
  );
  if (!allowed.allowed) return { status: "refused", reason: allowed.reason };
  const approval = chooseApproval(deps, target);
  if (approval === undefined) return { status: "refused", reason: "NO_APPROVAL" };
  return deployRelease(
    {
      ...deps,
      pipeline: {
        workflow: config.workflow,
        ref: config.tag_ref,
        workflowSha: config.workflow_sha,
        issueNumber: config.issue_number,
        allowedActors: config.allowed_actors,
        authorActor: config.author_actor,
      },
    },
    {
      repository: deps.repository,
      environment: target.target_environment,
      artifactDigest: target.artifact_digest,
      approvalId: approval.id,
    },
  );
}

/**
 * The newest unexpired approved decision for the target's current digest; otherwise the newest
 * request for the target, so `deployRelease` names why it is not usable (pending, stale, expired).
 */
function chooseApproval(
  deps: DeployConfiguredReleaseDeps,
  target: DeployTarget,
): ApprovalRequest | undefined {
  const currentHash = approvalSubjectHash({
    kind: "deploy",
    artifactDigest: target.artifact_digest,
    environment: target.target_environment,
  });
  const now = deps.now();
  const newestFirst = deps.approvals
    .list()
    .filter((request) => request.subject.kind === "deploy" && request.subjectId === target.id)
    .sort((a, b) => b.requestedAt - a.requestedAt || a.id.localeCompare(b.id));
  return (
    newestFirst.find(
      (request) =>
        request.status === "approved" &&
        request.subjectHash === currentHash &&
        (request.expiresAt === undefined || now < request.expiresAt),
    ) ?? newestFirst[0]
  );
}
