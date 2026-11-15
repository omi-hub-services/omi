import type { DeployTarget } from "../../application/contracts/project-config.js";
import type { ApprovalSubjectReader } from "../../application/ports/approval-store.js";

/**
 * Deploy approval subjects from the project's own `deploy_targets` (ADR-0037). The subject comes
 * only from this validated config, never from the request, so editing a target's digest or
 * environment changes the subject hash. An id listed twice is ambiguous and fails closed.
 */
export function createConfigDeploySubjects(
  targets: readonly DeployTarget[] | undefined,
): ApprovalSubjectReader {
  return {
    read(subjectId, kind) {
      if (kind !== "deploy") return undefined;
      const matches = (targets ?? []).filter((target) => target.id === subjectId);
      const [target] = matches;
      if (matches.length !== 1 || target === undefined) return undefined;
      return {
        kind: "deploy",
        artifactDigest: target.artifact_digest,
        environment: target.target_environment,
      };
    },
  };
}
