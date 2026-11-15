import type { CarryFacts } from "../../domain/delivery/carried-pass-policy.js";

export type MergeBaseResult =
  /** The branch already contains the integration branch; nothing was changed. */
  | { readonly kind: "up-to-date"; readonly head: string }
  /** The merge does not apply cleanly; nothing was changed. */
  | { readonly kind: "conflict"; readonly files: readonly string[] }
  | {
      readonly kind: "merged";
      readonly oldHead: string;
      readonly newHead: string;
      /** Tree of the automatic merge, equal to the tree of `newHead`. */
      readonly mergeTree: string;
      /** The integration-branch commit that was merged in. */
      readonly baseCommit: string;
    };

/**
 * Local Git reads and writes behind a carried PASS. Bound to one repository and its integration
 * branch. Failures throw `GitWorkspaceError`; a conflict is a result, never an error.
 */
export interface BranchSync {
  /** Parents, base membership, tree and automatic-merge tree of `commit`. Read only. */
  facts(commit: string): CarryFacts;
  /** Fetches the integration branch and merges it into the worktree's branch when it is clean. */
  mergeBase(worktreePath: string): MergeBaseResult;
  /** Pushes the worktree's branch to origin without force. */
  push(worktreePath: string): void;
}
