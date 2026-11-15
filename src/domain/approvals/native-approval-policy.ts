/** One native GitHub pull-request review, as read from GitHub. Never produced by the runtime. */
export interface NativeReviewObservation {
  readonly actor: string;
  /** GitHub account type; only a `User` can give a native approval that counts. */
  readonly actorType: string;
  readonly state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  /** Commit the review was submitted on. */
  readonly commitSha: string;
}

export interface NativeApprovalInputs {
  /** Approvals GitHub requires (ruleset) or the project requires, whichever is higher. */
  readonly requiredCount: number;
  readonly pullAuthor: string;
  /** Accounts the runtime itself acts as; their reviews are never a native approval. */
  readonly runtimeActors: readonly string[];
  /** Reviews in submission order, oldest first. */
  readonly reviews: readonly NativeReviewObservation[];
}

/** Latest decisive review per case-insensitive GitHub identity; comments do not revoke reviews. */
export function latestNativeReviews(
  reviews: readonly NativeReviewObservation[],
): NativeReviewObservation[] {
  const latest = new Map<string, NativeReviewObservation>();
  for (const review of reviews) {
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.actor.toLowerCase(), review);
  }
  return [...latest.values()];
}

/**
 * Native approval is read from GitHub and only counted, never created (ADR-0026, architecture.md
 * §11). Per reviewer the latest decisive review (approve, request changes, dismissal) counts, as
 * on GitHub. An approval counts only for the current head, from a `User` who is neither the PR
 * author nor an account the runtime acts as: two agents behind one identity are not two reviewers.
 */
export function nativeApprovalRefusals(
  native: NativeApprovalInputs,
  headSha: string,
): ("NATIVE_CHANGES_REQUESTED" | "NATIVE_APPROVAL_MISSING")[] {
  const decisive = latestNativeReviews(native.reviews);
  const refusals: ("NATIVE_CHANGES_REQUESTED" | "NATIVE_APPROVAL_MISSING")[] = [];
  if (decisive.some((review) => review.state === "CHANGES_REQUESTED")) {
    refusals.push("NATIVE_CHANGES_REQUESTED");
  }
  const approvals = eligibleNativeApprovals(native).filter(
    (review) => review.commitSha === headSha,
  );
  if (approvals.length < native.requiredCount) refusals.push("NATIVE_APPROVAL_MISSING");
  return refusals;
}

/** Native human approvals excluding the author/runtime; callers must additionally pin the head. */
export function eligibleNativeApprovals(native: NativeApprovalInputs): NativeReviewObservation[] {
  const excluded = [native.pullAuthor, ...native.runtimeActors].map((actor) => actor.toLowerCase());
  return latestNativeReviews(native.reviews).filter(
    (review) =>
      review.state === "APPROVED" &&
      review.actorType === "User" &&
      !excluded.includes(review.actor.toLowerCase()),
  );
}
