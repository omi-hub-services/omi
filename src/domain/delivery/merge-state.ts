import { applyTransition, ruleBuilder } from "../shared/transition.js";
import type { TransitionOutcome, TransitionRule } from "../shared/transition.js";

/**
 * Lifecycle of one PR's merge. `merge_unknown` exists because a merge call can time out after
 * the remote already merged: the only exits are a remote read-back (`reconciled_*`); a second
 * merge call is not a transition from there (architecture.md §11, design-patterns.md §7).
 */
export const MERGE_STATUSES = [
  "not_ready",
  "ready",
  "merge_requested",
  "merge_unknown",
  "merged",
] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];

export type MergeEvent =
  | {
      readonly type: "gates_passed";
      /** Head SHA the gates were evaluated on and the head currently on the remote. */
      readonly evaluatedHeadSha: string;
      readonly currentHeadSha: string;
    }
  | { readonly type: "revision_changed" }
  | {
      readonly type: "merge_requested";
      readonly decisionAllowed: boolean;
      readonly expectedHeadSha: string;
      readonly currentHeadSha: string;
    }
  | {
      readonly type: "merge_confirmed";
      readonly remoteMerged: boolean;
      readonly mergeCommitSha: string;
    }
  | { readonly type: "merge_rejected" }
  | { readonly type: "merge_outcome_unknown" }
  | { readonly type: "reconciled_merged"; readonly remoteMerged: boolean }
  | { readonly type: "reconciled_not_merged"; readonly remoteMerged: boolean };

export type MergeStateRefusal =
  | "STALE_REVISION"
  | "MERGE_NOT_ALLOWED"
  | "REMOTE_NOT_MERGED"
  | "REMOTE_ALREADY_MERGED"
  | "MERGE_COMMIT_MISSING";

const rule = ruleBuilder<MergeStatus, MergeEvent, MergeStateRefusal>();

export const MERGE_RULES: readonly TransitionRule<MergeStatus, MergeEvent, MergeStateRefusal>[] = [
  rule("not_ready", "gates_passed", "ready", (e) =>
    e.evaluatedHeadSha === e.currentHeadSha ? undefined : "STALE_REVISION",
  ),
  // New commits or a moved base make every earlier piece of evidence stale.
  rule("ready", "revision_changed", "not_ready"),
  rule("ready", "merge_requested", "merge_requested", (e) => {
    if (!e.decisionAllowed) return "MERGE_NOT_ALLOWED";
    return e.expectedHeadSha === e.currentHeadSha ? undefined : "STALE_REVISION";
  }),
  rule("merge_requested", "merge_confirmed", "merged", (e) => {
    if (!e.remoteMerged) return "REMOTE_NOT_MERGED";
    return e.mergeCommitSha.trim() === "" ? "MERGE_COMMIT_MISSING" : undefined;
  }),
  rule("merge_requested", "merge_rejected", "not_ready"),
  rule("merge_requested", "merge_outcome_unknown", "merge_unknown"),
  rule("merge_unknown", "reconciled_merged", "merged", (e) =>
    e.remoteMerged ? undefined : "REMOTE_NOT_MERGED",
  ),
  rule("merge_unknown", "reconciled_not_merged", "not_ready", (e) =>
    e.remoteMerged ? "REMOTE_ALREADY_MERGED" : undefined,
  ),
];

export function transitionMerge(
  from: MergeStatus,
  event: MergeEvent,
): TransitionOutcome<MergeStatus, MergeStateRefusal> {
  return applyTransition(MERGE_RULES, from, event);
}
