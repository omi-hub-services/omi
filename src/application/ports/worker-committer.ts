/** Local Git only; normal commit hooks run, with no push or history rewriting. */
export interface WorkerCommitter {
  stagedPaths(workspace: string): readonly string[];
  stage(workspace: string, paths: readonly string[]): void;
  /** Restore only these index entries to HEAD; preserve worktree bytes and all other entries. */
  unstage(workspace: string, paths: readonly string[]): void;
  commit(workspace: string, message: string): string;
}
