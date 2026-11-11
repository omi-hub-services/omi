import { mergePullSchema } from "../../contracts/merge-delivery.js";
import { githubOperationSchema } from "../../contracts/github-operation.js";
import type { GithubOperation } from "../../contracts/github-operation.js";
import { publishReleaseSchema } from "../../contracts/release-delivery.js";
import { DeliveryError } from "../../ports/pr-delivery.js";
import type { MergeDeliveryReader } from "../../ports/merge-delivery.js";
import type { ReleaseReader } from "../../ports/release-delivery.js";
import { deliverGithubOperation } from "../../services/deliver-github-operation.js";
import type { DeliverGithubOperationDeps } from "../../services/deliver-github-operation.js";
import {
  RELEASE_BASE,
  evaluateReleaseArtifacts,
  hasClosingReference,
  releaseArtifactKey,
  releaseNotes,
  releaseTagKey,
  releaseTasks,
} from "../../../domain/delivery/release-policy.js";
import type {
  ReleaseArtifactRefusal,
  ReleaseTask,
} from "../../../domain/delivery/release-policy.js";

export type PublishReleaseDeps = DeliverGithubOperationDeps & {
  readonly releases: ReleaseReader;
  readonly pulls: Pick<MergeDeliveryReader, "pull" | "branchContains">;
};

export type PublishReleaseResult =
  | {
      readonly status: "published";
      readonly tag: string;
      readonly commitSha: string;
      readonly releaseIdentity: string;
      readonly tasks: readonly ReleaseTask[];
    }
  | { readonly status: "refused"; readonly reason: ReleaseArtifactRefusal }
  | { readonly status: "pending"; readonly operationKey: string; readonly state: string };

/**
 * After the release PR is merged into `main` (and only then): tag the merge commit, then create
 * the GitHub Release whose notes list the tasks of this release. Both go through the outbox with
 * stable keys and a look-before-write adapter, so a retry after a lost response reuses the tag and
 * release that exist. Nothing here merges anything. Run serially on the runtime writer.
 */
export async function publishRelease(
  deps: PublishReleaseDeps,
  input: unknown,
): Promise<PublishReleaseResult> {
  const { repository, release, prNumber, title } = publishReleaseSchema.parse(input);
  const pull = mergePullSchema.parse(await deps.pulls.pull(repository, prNumber));
  if (pull.number !== prNumber || pull.repository !== repository)
    throw new DeliveryError("PR_IDENTITY_MISMATCH");
  const sha = pull.mergeCommitSha;
  const onMain =
    pull.merged && sha !== null && (await deps.pulls.branchContains(repository, RELEASE_BASE, sha));
  const decision = evaluateReleaseArtifacts({
    headRef: pull.headRef,
    baseRef: pull.baseRef,
    state: pull.state,
    merged: pull.merged,
    mergeCommitSha: sha,
    onMain,
  });
  if (!decision.allowed || sha === null)
    return {
      status: "refused",
      reason: decision.allowed ? "MERGE_COMMIT_MISSING" : decision.reason,
    };

  const releasePulls = await deps.releases.mergedReleasePulls(repository);
  const thisRelease = releasePulls.find((p) => p.number === prNumber);
  if (thisRelease === undefined) throw new DeliveryError("RELEASE_PR_NOT_LISTED");
  const previous = releasePulls
    .filter(
      (p) => p.number !== prNumber && Date.parse(p.mergedAt) < Date.parse(thisRelease.mergedAt),
    )
    .map((p) => Date.parse(p.mergedAt));
  const tasks = releaseTasks(
    await deps.releases.mergedDevelopPulls(repository),
    previous.length === 0 ? undefined : new Date(Math.max(...previous)).toISOString(),
    thisRelease.mergedAt,
  );
  const notes = releaseNotes(release, prNumber, sha, tasks);
  if (hasClosingReference(notes)) throw new DeliveryError("CLOSING_REFERENCE_FORBIDDEN");

  const tag = await deliver(deps, releaseTagKey(repository, release), {
    type: "git_tag.create",
    repo: repository,
    tag: release,
    sha,
  });
  if ("status" in tag) return tag;
  const created = await deliver(deps, releaseArtifactKey(repository, release), {
    type: "release.create",
    repo: repository,
    tag: release,
    sha,
    title: title ?? `Release ${release}`,
    body: notes,
  });
  if ("status" in created) return created;
  return {
    status: "published",
    tag: release,
    commitSha: sha,
    releaseIdentity: created.remoteIdentity ?? "",
    tasks,
  };
}

async function deliver(
  deps: PublishReleaseDeps,
  key: string,
  operation: GithubOperation,
): Promise<
  | { readonly remoteIdentity: string | null }
  | { readonly status: "pending"; readonly operationKey: string; readonly state: string }
> {
  const outcome = await deliverGithubOperation(deps, key, githubOperationSchema.parse(operation));
  if (outcome.kind === "failed") throw new DeliveryError(outcome.code);
  return outcome.kind === "succeeded"
    ? { remoteIdentity: outcome.remoteIdentity }
    : { status: "pending", operationKey: outcome.operationKey, state: outcome.state };
}
