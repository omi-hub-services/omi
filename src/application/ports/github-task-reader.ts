import type { DependencyIssue } from "../../domain/tasks/dependency-policy.js";
import type { TaskIssue, TaskItem } from "../contracts/task-import.js";

export class TaskImportError extends Error {
  override readonly name = "TaskImportError";
  readonly code: string;
  readonly dependencyIssues: readonly DependencyIssue[];
  constructor(code: string, dependencyIssues: readonly DependencyIssue[] = []) {
    super(`Task import failed: ${code}`);
    this.code = code;
    this.dependencyIssues = dependencyIssues;
  }
}

/** Complete, validated read-only results. Inaccessible content or incomplete pages throw. */
export interface GithubTaskReader {
  items(projectId: string): Promise<readonly TaskItem[]>;
  issue(issueId: string): Promise<TaskIssue>;
}
