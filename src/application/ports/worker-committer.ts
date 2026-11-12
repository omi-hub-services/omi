/** Local Git only; normal commit hooks run, with no push or history rewriting. */
export interface WorkerCommitter {
  stagedPaths(workspace: string): readonly string[];
  stage(workspace: string, paths: readonly string[]): void;
  commit(workspace: string, message: string): string;
}
