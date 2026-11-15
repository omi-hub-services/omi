import { mergeCommitSchema, mergePullSchema } from "../../contracts/merge-delivery.js";
import type { MergePull } from "../../contracts/merge-delivery.js";
import { mergeReleaseSchema } from "../../contracts/release-merge.js";
import type { MergeReleaseRequest } from "../../contracts/release-merge.js";
import { DeliveryError } from "../../ports/pr-delivery.js";
import type { ReleaseMergeReader } from "../../ports/release-merge.js";
import {
  deliverGithubOperation,
  reconcileGithubOperation,
} from "../../services/deliver-github-operation.js";
import type { DeliverGithubOperationDeps } from "../../services/deliver-github-operation.js";
import { RELEASE_BASE, releasePullKey } from "../../../domain/delivery/release-policy.js";
import { evaluateMergeConfirmation } from "../../../domain/delivery/merge-policy.js";
import { operationMarker } from "../../../domain/delivery/operation-marker.js";
import { checkReleaseMerge } from "./check-release-merge.js";

export type MergeReleaseDeps = DeliverGithubOperationDeps & {
  readonly reader: ReleaseMergeReader;
};

export type MergeReleaseStep = "gate" | "merge" | "confirm";

export type MergeReleaseResult =
  | { readonly status: "done"; readonly mergeCommitSha: string }
  /** The merge is not settled yet; call again with the same request (its outcome is read first). */
  | {
      readonly status: "pending";
      readonly operationKey: string;
      readonly state: string;
    }
  | {
      readonly status: "refused";
      readonly step: MergeReleaseStep;
      readonly reasons: readonly string[];
    };

const refused = (step: MergeReleaseStep, reasons: readonly string[]): MergeReleaseResult => ({
  status: "refused",
  step,
  reasons,
});

/**
 * Merges the release PR `develop` → `main` on the exact head the PO approved. It runs
 * `checkReleaseMerge` (PO native approval on that head, checks, permissions) and only when that
 * allows, queues a native merge pinned to `sha` = the approved head through the outbox. The merge
 * commit must then be on `main` with the approved head as a parent. Nothing bypasses a refusal and
 * the refusal reasons are returned as they are.
 *
 * Idempotent: a retry first reads back an earlier attempt, never sends a second merge for a PR
 * that is merged, and an already merged PR is only confirmed. This is the release counterpart of
 * `mergeTaskPr`; the durable deploy approval and the environment approval stay separate (ADR-0014
 * is untouched, see the handbook "Release merge"). Run serially on the runtime writer.
 */
export async function mergeRelease(
  deps: MergeReleaseDeps,
  input: unknown,
): Promise<MergeReleaseResult> {
  const parsed = mergeReleaseSchema.safeParse(input);
  if (!parsed.success) return refused("gate", ["INVALID_RELEASE_REQUEST"]);
  const { release, ...gateRequest } = parsed.data;
  const request = parsed.data;
  const key = `merge-release:${request.repository}#${String(request.prNumber)}@${request.expectedHeadSha}`;
  operationMarker(key);

  // A lost response of an earlier merge call is found by read-back before anything is decided.
  let pull: MergePull;
  try {
    await reconcileGithubOperation(deps, key);
    pull = await readPull(deps, request);
  } catch (error) {
    // Same typed refusals as the gate: an unreadable or foreign PR never reaches a merge.
    return refused("gate", [
      error instanceof DeliveryError && error.code === "PR_IDENTITY_MISMATCH"
        ? "PR_IDENTITY_MISMATCH"
        : "PR_READ_UNAVAILABLE",
    ]);
  }
  if (!pull.merged) {
    const decision = await checkReleaseMerge(deps.reader, gateRequest);
    if (!decision.allowed) return refused("gate", decision.reasons);
    const outcome = await deliverGithubOperation(deps, key, {
      type: "pull_request.merge",
      repo: request.repository,
      pullNumber: request.prNumber,
      base: RELEASE_BASE,
      expectedHeadSha: request.expectedHeadSha,
      prOperationKey: releasePullKey(request.repository, release),
    });
    if (outcome.kind === "pending")
      return { status: "pending", operationKey: outcome.operationKey, state: outcome.state };
    // GitHub refused after the gate passed (e.g. a moved head: 409). Keep its reason.
    if (outcome.kind === "failed") return refused("merge", ["MERGE_REJECTED", outcome.code]);
    pull = await readPull(deps, request);
  }
  return confirmMerge(deps, request, pull);
}

async function confirmMerge(
  deps: MergeReleaseDeps,
  request: MergeReleaseRequest,
  pull: MergePull,
): Promise<MergeReleaseResult> {
  const sha = pull.mergeCommitSha;
  const commit =
    pull.merged && sha !== null
      ? mergeCommitSchema.parse(await deps.reader.commit(request.repository, sha))
      : undefined;
  const onMain =
    sha !== null &&
    commit?.sha === sha &&
    (await deps.reader.branchContains(request.repository, RELEASE_BASE, sha));
  const decision = evaluateMergeConfirmation({
    merged: pull.merged,
    targetBranch: pull.baseRef,
    expectedTargetBranch: RELEASE_BASE,
    mergedHeadSha: pull.headSha,
    expectedHeadSha: request.expectedHeadSha,
    mergeCommitSha: sha,
    mergeCommitParents: commit?.parents ?? [],
    mergeCommitOnTarget: onMain,
  });
  if (!decision.allowed) return refused("confirm", decision.reasons);
  return { status: "done", mergeCommitSha: sha ?? "" };
}

async function readPull(deps: MergeReleaseDeps, request: MergeReleaseRequest): Promise<MergePull> {
  const pull = mergePullSchema.parse(await deps.reader.pull(request.repository, request.prNumber));
  if (pull.number !== request.prNumber || pull.repository !== request.repository)
    throw new DeliveryError("PR_IDENTITY_MISMATCH");
  return pull;
}
