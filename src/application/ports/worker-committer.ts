/** Local Git only. Commits never execute repository hooks; configuration is not changed. */
export interface WorkerCommitter {
  committedPaths(workspace: string, baseSha: string, headSha: string): readonly string[];
  /** Undo only the local commit just made; preserve worktree files and clear the index. */
  undoCommit(workspace: string, baseSha: string): void;
  stagedPaths(workspace: string): readonly string[];
  stage(workspace: string, paths: readonly string[]): void;
  /** Restore only these index entries to HEAD; preserve worktree bytes and all other entries. */
  unstage(workspace: string, paths: readonly string[]): void;
  commit(workspace: string, message: string): string;
}
