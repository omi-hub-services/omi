import {
  branchRulesSchema,
  checkObservationsSchema,
  mergePullSchema,
  nativeReviewsSchema,
} from "../../contracts/merge-delivery.js";
import {
  releaseMergeRequestSchema,
  releaseRestrictionsSchema,
} from "../../contracts/release-merge.js";
import type { ReleaseMergeReader } from "../../ports/release-merge.js";
import { evaluateReleaseMerge, RELEASE_BASE } from "../../../domain/delivery/release-policy.js";
import type { ReleaseMergeRefusal } from "../../../domain/delivery/release-policy.js";
import { decide } from "../../../domain/shared/decision.js";
import type { Decision } from "../../../domain/shared/decision.js";

export type ReleaseGateRefusal =
  | ReleaseMergeRefusal
  | "INVALID_RELEASE_REQUEST"
  | "PR_IDENTITY_MISMATCH"
  | "PR_READ_UNAVAILABLE"
  | "REVIEWS_READ_UNAVAILABLE"
  | "RULES_READ_UNAVAILABLE"
  | "CHECKS_READ_UNAVAILABLE"
  | "PERMISSIONS_READ_UNAVAILABLE";

/** Read-only gate, not a durable merge authorization. Re-run immediately before merging with a SHA guard. */
export async function checkReleaseMerge(
  reader: ReleaseMergeReader,
  raw: unknown,
): Promise<Decision<ReleaseGateRefusal>> {
  const parsed = releaseMergeRequestSchema.safeParse(raw);
  if (!parsed.success) return decide(["INVALID_RELEASE_REQUEST"]);
  const request = parsed.data;
  let stage: ReleaseGateRefusal = "PR_READ_UNAVAILABLE";
  try {
    const pull = mergePullSchema.parse(await reader.pull(request.repository, request.prNumber));
    if (pull.number !== request.prNumber || pull.repository !== request.repository)
      return decide(["PR_IDENTITY_MISMATCH"]);
    stage = "PERMISSIONS_READ_UNAVAILABLE";
    const actor = await reader.authenticatedActor();
    if (actor.trim() === "") return decide([stage]);
    const restrictions = releaseRestrictionsSchema.parse(
      await reader.releaseRestrictions(request.repository, RELEASE_BASE, actor),
    );
    stage = "RULES_READ_UNAVAILABLE";
    const rules = branchRulesSchema.parse(
      await reader.branchRules(request.repository, RELEASE_BASE),
    );
    stage = "REVIEWS_READ_UNAVAILABLE";
    const reviews = nativeReviewsSchema.parse(
      await reader.nativeReviews(request.repository, request.prNumber),
    );
    stage = "CHECKS_READ_UNAVAILABLE";
    const checks = checkObservationsSchema.parse(
      await reader.checks(request.repository, pull.headSha),
    );
    // Close the read window: a push during review/check reads invalidates this snapshot too.
    stage = "PR_READ_UNAVAILABLE";
    const current = mergePullSchema.parse(await reader.pull(request.repository, request.prNumber));
    if (current.number !== request.prNumber || current.repository !== request.repository)
      return decide(["PR_IDENTITY_MISMATCH"]);
    if (current.headSha !== pull.headSha || current.author !== pull.author)
      return decide(["HEAD_MOVED"]);
    return evaluateReleaseMerge({
      headRef: current.headRef,
      baseRef: current.baseRef,
      open: current.state === "open" && !current.merged,
      currentHeadSha: current.headSha,
      expectedHeadSha: request.expectedHeadSha,
      poActors: request.poActors,
      canMerge: restrictions.canMerge,
      mergeableState: current.mergeableState,
      requiredChecks: [
        ...new Set([
          ...request.requiredChecks,
          ...rules.requiredChecks,
          ...restrictions.requiredChecks,
        ]),
      ],
      checks,
      nativeApproval: {
        requiredCount: Math.max(
          1,
          rules.requiredApprovingReviewCount,
          restrictions.requiredApprovingReviewCount,
        ),
        pullAuthor: current.author,
        runtimeActors: [actor],
        reviews,
      },
    });
  } catch {
    return decide([stage]);
  }
}
