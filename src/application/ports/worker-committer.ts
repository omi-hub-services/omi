/** Local Git only; normal commit hooks run, with no push or history rewriting. */
export interface WorkerCommitter {
  hooksTrusted(workspace: string): boolean;
  committedPaths(workspace: string, baseSha: string, headSha: string): readonly string[];
  /** Undo only the local commit just made; preserve worktree files and clear the index. */
  undoCommit(workspace: string, baseSha: string): void;
  stagedPaths(workspace: string): readonly string[];
  stage(workspace: string, paths: readonly string[]): void;
  /** Restore only these index entries to HEAD; preserve worktree bytes and all other entries. */
  unstage(workspace: string, paths: readonly string[]): void;
  commit(workspace: string, message: string): string;
}
