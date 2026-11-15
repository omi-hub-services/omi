import type { ReleaseRestrictions } from "../contracts/release-merge.js";
import type { MergeDeliveryReader } from "./merge-delivery.js";

/** Reuses the task delivery reader; no approval or merge write capability. */
export interface ReleaseMergeReader extends Pick<
  MergeDeliveryReader,
  | "pull"
  | "checks"
  | "nativeReviews"
  | "authenticatedActor"
  | "branchRules"
  | "commit"
  | "branchContains"
> {
  /** Effective write permission and classic branch protection, in addition to rulesets. */
  releaseRestrictions(
    repository: string,
    branch: string,
    actor: string,
  ): Promise<ReleaseRestrictions>;
}
