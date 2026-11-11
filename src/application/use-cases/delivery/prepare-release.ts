import {
  RELEASE_BASE,
  RELEASE_HEAD,
  hasClosingReference,
  isReleaseBranchFlow,
  releaseIssueBody,
  releaseIssueKey,
  releasePullBody,
  releasePullKey,
  releaseTasks,
} from "../../../domain/delivery/release-policy.js";
import type { ReleaseTask } from "../../../domain/delivery/release-policy.js";
import { operationMarker } from "../../../domain/delivery/operation-marker.js";
import { githubOperationSchema } from "../../contracts/github-operation.js";
import type { GithubOperation } from "../../contracts/github-operation.js";
import { deliveryPullSchema } from "../../contracts/pr-delivery.js";
import { prepareReleaseSchema } from "../../contracts/release-delivery.js";
import { DeliveryError } from "../../ports/pr-delivery.js";
import type { PrDeliveryReader } from "../../ports/pr-delivery.js";
import type { ReleaseReader } from "../../ports/release-delivery.js";
import {
  deliverGithubOperation,
  reconcileGithubOperation,
} from "../../services/deliver-github-operation.js";
import type { DeliverGithubOperationDeps } from "../../services/deliver-github-operation.js";

export type PrepareReleaseDeps = DeliverGithubOperationDeps & {
  readonly releases: ReleaseReader;
  readonly pulls: Pick<PrDeliveryReader, "findOpenPull" | "pull">;
};
type Pending = {
  readonly status: "pending";
  readonly operationKey: string;
  readonly state: string;
};
export type PrepareReleaseResult =
  | {
      readonly status: "verified";
      readonly releaseIssueNumber: number;
      readonly prNumber: number;
      readonly tasks: readonly ReleaseTask[];
    }
  | Pending;

/**
 * Opens the Release Issue (tasks merged into `develop` since the last release) and the release PR
 * `develop` → `main`. It only ever queues `issue.create` and `pull_request.create`: nothing here
 * can merge into `main`; the PR waits for the PO. Run serially on the runtime writer.
 */
export async function prepareRelease(
  deps: PrepareReleaseDeps,
  input: unknown,
): Promise<PrepareReleaseResult> {
  const { repository, release, title } = prepareReleaseSchema.parse(input);
  const tasks = releaseTasks(
    await deps.releases.mergedDevelopPulls(repository),
    await deps.releases.lastReleaseMergedAt(repository),
  );
  if (tasks.length === 0) throw new DeliveryError("RELEASE_EMPTY");

  const issueKey = releaseIssueKey(repository, release);
  const issueBody = releaseIssueBody(release, tasks);
  if (hasClosingReference(issueBody)) throw new DeliveryError("CLOSING_REFERENCE_FORBIDDEN");
  const issue = await deliver(deps, issueKey, {
    type: "issue.create",
    repo: repository,
    title: title ?? `Release ${release}`,
    body: issueBody,
  });
  if ("status" in issue) return issue;
  const issueNumber = issueNumberOf(issue.remoteIdentity, repository);

  const prKey = releasePullKey(repository, release);
  const prBody = releasePullBody(release, issueNumber, tasks);
  if (hasClosingReference(prBody)) throw new DeliveryError("CLOSING_REFERENCE_FORBIDDEN");
  let pull = await deps.pulls.findOpenPull(repository, RELEASE_HEAD, RELEASE_BASE);
  if (pull === undefined) {
    const created = await deliver(deps, prKey, {
      type: "pull_request.create",
      repo: repository,
      head: RELEASE_HEAD,
      base: RELEASE_BASE,
      title: title ?? `Release ${release}`,
      body: prBody,
    });
    if ("status" in created) return created;
    pull = await deps.pulls.findOpenPull(repository, RELEASE_HEAD, RELEASE_BASE);
    if (pull === undefined) throw new DeliveryError("PR_NOT_FOUND_AFTER_WRITE");
  }
  const verified = deliveryPullSchema.parse(await deps.pulls.pull(repository, pull.number));
  if (
    verified.number !== pull.number ||
    verified.repository !== repository ||
    !isReleaseBranchFlow(verified.head, verified.base) ||
    verified.state !== "open" ||
    (verified.body !== prBody && verified.body !== `${prBody}\n\n${operationMarker(prKey)}`)
  )
    throw new DeliveryError("PR_VERIFICATION_FAILED");
  await reconcileGithubOperation(deps, issueKey);
  await reconcileGithubOperation(deps, prKey);
  return { status: "verified", releaseIssueNumber: issueNumber, prNumber: verified.number, tasks };
}

async function deliver(
  deps: PrepareReleaseDeps,
  key: string,
  operation: GithubOperation,
): Promise<{ readonly remoteIdentity: string | null } | Pending> {
  const outcome = await deliverGithubOperation(deps, key, githubOperationSchema.parse(operation));
  if (outcome.kind === "failed") throw new DeliveryError(outcome.code);
  return outcome.kind === "succeeded"
    ? { remoteIdentity: outcome.remoteIdentity }
    : { status: "pending", operationKey: outcome.operationKey, state: outcome.state };
}

function issueNumberOf(remoteIdentity: string | null, repository: string): number {
  const prefix = `issue:${repository}#`;
  const number =
    remoteIdentity?.startsWith(prefix) === true ? Number(remoteIdentity.slice(prefix.length)) : NaN;
  if (!Number.isInteger(number) || number <= 0) throw new DeliveryError("RELEASE_ISSUE_UNVERIFIED");
  return number;
}
