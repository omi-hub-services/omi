// Pure "already done, skip" decisions so the live lifecycle harness can continue after a stop.
// Gates are never relaxed: a skip needs GitHub to show the same head the review/PO approved, and
// the independent-review check that mergeTaskPr would have made.
import type { MergeEvidence } from "../../../src/application/contracts/merge-delivery.ts";
import type { PrDeliveryReader } from "../../../src/application/ports/pr-delivery.ts";
import type { ReleaseReader } from "../../../src/application/ports/release-delivery.ts";
import { parseAcReviewLines } from "../../../src/domain/delivery/acceptance-review.ts";
import { evaluateIssueClose } from "../../../src/domain/delivery/merge-policy.ts";
import {
  RELEASE_BASE,
  RELEASE_HEAD,
  releaseTasks,
} from "../../../src/domain/delivery/release-policy.ts";
import { acceptanceCriteria } from "../../../src/domain/tasks/acceptance-criteria.ts";

interface ResumePull {
  readonly number: number;
  readonly state: string;
  readonly merged: boolean;
  readonly headSha: string;
  readonly baseRef: string;
  readonly mergeCommitSha: string | null;
}

export type TaskResume =
  | { readonly action: "run" }
  | { readonly action: "skip"; readonly prNumber: number; readonly mergeCommitSha: string };

export function decideTaskResume(input: {
  readonly evidence: MergeEvidence;
  readonly issueBody?: string | undefined;
  readonly pull?: ResumePull | undefined;
  readonly onDevelop?: boolean | undefined;
}): TaskResume {
  const { pull, evidence } = input;
  if (pull === undefined || pull.state === "open") return { action: "run" };
  const label = `mapped PR #${String(pull.number)}`;
  if (!pull.merged) throw new Error(`${label} closed without merge`);
  const review = evidence.review;
  if (review === undefined) throw new Error("independent review required");
  if (pull.headSha !== review.headSha)
    throw new Error(`${label} head differs from the reviewed head`);
  if (pull.baseRef !== "develop") throw new Error(`${label} did not merge into develop`);
  if (pull.mergeCommitSha === null || input.onDevelop !== true)
    throw new Error(`merge commit of PR #${String(pull.number)} is not on develop`);
  // The same domain check mergeTaskPr applies before it ticks and closes: skipping must not drop it.
  const decision = evaluateIssueClose({
    merged: true,
    mergedHeadSha: pull.headSha,
    review: {
      reviewerRunId: review.reviewerRunId,
      reviewerAgentId: review.reviewerAgentId,
      headSha: review.headSha,
      baseSha: review.baseSha,
      passed: review.verdict === "pass",
      acLines: parseAcReviewLines(review.body),
    },
    acceptanceCriteriaCount: acceptanceCriteria(input.issueBody ?? "").length,
    authorRunIds: evidence.authorRunIds,
    authorAgentIds: evidence.authorAgentIds,
  });
  if (!decision.allowed)
    throw new Error(`${label} review not acceptable: ${decision.reasons.join(", ")}`);
  return { action: "skip", prNumber: pull.number, mergeCommitSha: pull.mergeCommitSha };
}

export type ReleaseResume =
  { readonly action: "wait" } | { readonly action: "skip"; readonly mergeCommitSha: string };

export function decideReleaseResume(input: {
  readonly pull: ResumePull;
  readonly onMain?: boolean | undefined;
  readonly reviews: readonly { actor: string; state: string; commitSha: string }[];
  readonly poActors: readonly string[];
}): ReleaseResume {
  const { pull } = input;
  if (pull.state === "open") return { action: "wait" };
  if (!pull.merged) throw new Error(`release PR #${String(pull.number)} closed without merge`);
  const po = input.poActors.map((a) => a.toLowerCase());
  const latest = input.reviews
    .filter((r) => po.includes(r.actor.toLowerCase()) && r.commitSha === pull.headSha)
    .at(-1);
  if (latest?.state !== "APPROVED")
    throw new Error(`release PR #${String(pull.number)} merged without PO approval on its head`);
  if (pull.baseRef !== "main" || pull.mergeCommitSha === null || input.onMain !== true)
    throw new Error(`merge commit of release PR #${String(pull.number)} is not on main`);
  return { action: "skip", mergeCommitSha: pull.mergeCommitSha };
}

export type ReleaseIdentity =
  { readonly kind: "prepare" } | { readonly kind: "merged"; readonly prNumber: number };

/**
 * Finds the release PR before `prepareRelease` runs: prepareRelease only discovers open PRs and
 * throws RELEASE_EMPTY once the release merged. An open PR, or tasks still waiting for a release,
 * mean prepare as usual; otherwise the merged release PR that names this release is the identity.
 */
export async function resolveReleaseIdentity(
  deps: {
    readonly pulls: Pick<PrDeliveryReader, "findOpenPull">;
    readonly releases: ReleaseReader;
  },
  repository: string,
  release: string,
): Promise<ReleaseIdentity> {
  if ((await deps.pulls.findOpenPull(repository, RELEASE_HEAD, RELEASE_BASE)) !== undefined)
    return { kind: "prepare" };
  const waiting = releaseTasks(
    await deps.releases.mergedDevelopPulls(repository),
    await deps.releases.lastReleaseMergedAt(repository),
  );
  if (waiting.length > 0) return { kind: "prepare" };
  const marker = `Release: ${release}`;
  const merged = (await deps.releases.mergedReleasePulls(repository))
    .filter((p) => p.body.split("\n").includes(marker))
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))
    .at(-1);
  if (merged === undefined)
    throw new Error(`no open or merged release PR found for ${release}; nothing to release`);
  return { kind: "merged", prNumber: merged.number };
}
