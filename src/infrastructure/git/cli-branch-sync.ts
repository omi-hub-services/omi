import type { BranchSync } from "../../application/ports/branch-sync.js";
import { GitWorkspaceError } from "../../application/ports/git-workspace.js";
import { gitCommand } from "./git-command.js";

export interface CliBranchSyncOptions {
  /** Any checkout of the repository; worktrees share its objects and refs. */
  readonly repositoryPath: string;
  readonly baseBranch: string;
  readonly remote?: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const TREE = /^[0-9a-f]{40,64}$/;
/** The merge commit is the runtime's, not the worker's. */
const IDENTITY = [
  "-c",
  "user.name=omi-squad runtime",
  "-c",
  "user.email=runtime@omi-squad.invalid",
];

/**
 * `git merge-tree --write-tree --name-only`: exit 0 prints the tree; exit 1 prints a tree and the
 * conflicted paths up to the first blank line. It only adds tree objects, so a conflict leaves
 * the branch and worktree untouched.
 */
function mergeTree(
  cwd: string,
  left: string,
  right: string,
): { readonly tree: string } | { readonly files: readonly string[] } {
  const { stdout, code } = gitCommand(
    cwd,
    ["merge-tree", "--write-tree", "--name-only", left, right],
    { allowedCodes: [0, 1] },
  );
  const lines = stdout.split("\n");
  const tree = lines[0]?.trim() ?? "";
  if (!TREE.test(tree)) throw new GitWorkspaceError("GIT_FAILED");
  if (code === 0) return { tree };
  const blank = lines.indexOf("", 1);
  const files = lines.slice(1, blank === -1 ? undefined : blank).filter(Boolean);
  return { files: [...new Set(files)] };
}

export function createCliBranchSync(options: CliBranchSyncOptions): BranchSync {
  const remote = options.remote ?? "origin";
  const baseRef = `${remote}/${options.baseBranch}`;
  const out = (cwd: string, args: readonly string[]): string => gitCommand(cwd, args).stdout.trim();

  return {
    facts(commit) {
      if (!FULL_SHA.test(commit)) throw new GitWorkspaceError("INVALID_INPUT");
      const cwd = options.repositoryPath;
      const [head = "", ...parents] = out(cwd, ["rev-list", "--parents", "-n", "1", commit]).split(
        /\s+/,
      );
      const headTree = out(cwd, ["show", "-s", "--format=%T", head]);
      const [first, second] = parents;
      if (parents.length !== 2 || first === undefined || second === undefined) {
        return { head, parents, secondParentOnBase: false, headTree, mergeTree: null };
      }
      const onBase = gitCommand(cwd, ["merge-base", "--is-ancestor", second, baseRef], {
        allowedCodes: [0, 1],
      });
      const merged = mergeTree(cwd, first, second);
      return {
        head,
        parents,
        secondParentOnBase: onBase.code === 0,
        headTree,
        mergeTree: "tree" in merged ? merged.tree : null,
      };
    },

    mergeBase(worktreePath) {
      gitCommand(worktreePath, ["fetch", "--quiet", remote, options.baseBranch]);
      const oldHead = out(worktreePath, ["rev-parse", "HEAD"]);
      const contained = gitCommand(worktreePath, ["merge-base", "--is-ancestor", baseRef, "HEAD"], {
        allowedCodes: [0, 1],
      });
      if (contained.code === 0) return { kind: "up-to-date", head: oldHead };
      const merged = mergeTree(worktreePath, "HEAD", baseRef);
      if ("files" in merged) return { kind: "conflict", files: merged.files };
      const baseCommit = out(worktreePath, ["rev-parse", baseRef]);
      gitCommand(worktreePath, [
        ...IDENTITY,
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `Merge ${baseRef} into the task branch`,
        baseRef,
      ]);
      const newHead = out(worktreePath, ["rev-parse", "HEAD"]);
      // The proof of an automatic merge: the tree git wrote equals the tree it merged.
      if (out(worktreePath, ["rev-parse", "HEAD^{tree}"]) !== merged.tree) {
        throw new GitWorkspaceError("GIT_FAILED");
      }
      return { kind: "merged", oldHead, newHead, mergeTree: merged.tree, baseCommit };
    },

    push(worktreePath) {
      const branch = out(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch === "HEAD") throw new GitWorkspaceError("INVALID_INPUT");
      gitCommand(worktreePath, ["push", "--quiet", remote, branch]);
    },
  };
}
