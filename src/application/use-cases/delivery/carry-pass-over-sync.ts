import { carryPassSchema } from "../../contracts/carried-pass.js";
import type { CarriedPassRecord } from "../../contracts/carried-pass.js";
import type { ArtifactStore } from "../../ports/artifact-store.js";
import type { BranchSync } from "../../ports/branch-sync.js";
import type { CheckRunner } from "../../ports/check-runner.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import type { MergeEvidenceReader } from "../../ports/merge-delivery.js";
import { resolveCarriedEvidence } from "../../services/resolve-carried-review.js";

export interface CarryPassDeps {
  readonly evidence: MergeEvidenceReader;
  readonly workspace: Pick<GitWorkspace, "inspect">;
  readonly sync: BranchSync;
  readonly checks: CheckRunner;
  readonly artifacts: ArtifactStore;
  readonly now: () => number;
  readonly nextId: () => string;
}

export type CarryPassResult =
  | { readonly status: "carried"; readonly record: CarriedPassRecord }
  /** The branch already contains the base; the PASS stands as it is. */
  | { readonly status: "up-to-date" }
  | {
      readonly status: "refused";
      readonly reasons: readonly string[];
      /** Set for `MERGE_CONFLICT`: only the resolution of these files needs a new review. */
      readonly conflictedFiles?: readonly string[];
    };

const refused = (...reasons: string[]): CarryPassResult => ({ status: "refused", reasons });

/**
 * A PR with a PASS fell BEHIND because another task merged first: merge the base into the branch,
 * re-run the required checks on the new head and, only for a clean merge, record the carried PASS
 * (old head, new head, automatic merge tree) and push. The merge gate then accepts the PASS
 * (`resolveCarriedEvidence`). A conflict is refused with its files and changes nothing; the
 * resolution needs its own review. A failing check leaves the merge commit local and unpushed.
 */
export async function carryPassOverSync(
  deps: CarryPassDeps,
  input: unknown,
): Promise<CarryPassResult> {
  const request = carryPassSchema.parse(input);
  const inspected = deps.workspace.inspect(request.worktreePath);
  if (!inspected.ok) return refused("WORKSPACE_UNREADABLE");
  const { headSha, branch, dirty } = inspected.value;
  if (dirty) return refused("WORKTREE_DIRTY");
  if (branch === null) return refused("DETACHED_HEAD");
  const evidence = resolveCarriedEvidence(deps, request.projectId, request.taskId, headSha);
  if (evidence.review?.verdict !== "pass") return refused("NO_VALID_PASS");
  const unconfigured = request.requiredChecks.filter((id) => !deps.checks.has(id));
  if (unconfigured.length > 0)
    return refused(...unconfigured.map((id) => `CHECK_UNCONFIGURED:${id}`));

  const merge = deps.sync.mergeBase(request.worktreePath);
  if (merge.kind === "up-to-date") return { status: "up-to-date" };
  if (merge.kind === "conflict") {
    return { status: "refused", reasons: ["MERGE_CONFLICT"], conflictedFiles: merge.files };
  }

  const checks: CarriedPassRecord["checks"] = [];
  for (const checkId of request.requiredChecks) {
    const run = await deps.checks.run({
      attemptId: request.attemptId,
      checkId,
      workspacePath: request.worktreePath,
      artifactRoot: request.artifactRoot,
    });
    checks.push({
      checkId,
      status: run.status,
      revision: run.revision,
      evidence: run.evidence,
    });
    if (run.status !== "passed" || run.revision !== merge.newHead) {
      return refused(`CHECK_NOT_PASSED:${checkId}`);
    }
  }

  deps.sync.push(request.worktreePath);
  const recordedAt = new Date(deps.now()).toISOString();
  const record: CarriedPassRecord = {
    schemaVersion: 1,
    taskId: request.taskId,
    oldHeadSha: merge.oldHead,
    newHeadSha: merge.newHead,
    baseCommit: merge.baseCommit,
    mergeTree: merge.mergeTree,
    checks,
    recordedAt,
  };
  deps.artifacts.write({
    id: deps.nextId(),
    path: `${request.artifactRoot}/carried-pass/${merge.newHead}.json`,
    bytes: new TextEncoder().encode(JSON.stringify(record)),
    producerAttemptId: request.attemptId,
    classification: "carried-pass",
    createdAt: recordedAt,
  });
  return { status: "carried", record };
}
