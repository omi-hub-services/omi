import {
  isTaskImportable,
  isTaskInScope,
  validateTaskDependencies,
} from "../../../domain/tasks/dependency-policy.js";
import {
  importTasksSchema,
  taskIssueSchema,
  taskItemSchema,
  taskSnapshotSchema,
} from "../../contracts/task-import.js";
import type { ImportedTasks, TaskIssue } from "../../contracts/task-import.js";
import type { ContentHasher } from "../../ports/content-hasher.js";
import { TaskImportError } from "../../ports/github-task-reader.js";
import type { GithubTaskReader } from "../../ports/github-task-reader.js";

/** Snapshot one chosen scope and its native dependency closure, without remote/local writes. */
export async function importTask(
  deps: { readonly reader: GithubTaskReader; readonly hasher: ContentHasher },
  input: unknown,
): Promise<ImportedTasks> {
  const request = importTasksSchema.parse(input);
  const items = (await deps.reader.items(request.projectId)).map((item) =>
    taskItemSchema.parse(item),
  );
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new TaskImportError("DUPLICATE_ITEM");
  const issues = new Map<string, TaskIssue>();
  const read = async (id: string): Promise<TaskIssue> => {
    const cached = issues.get(id);
    if (cached !== undefined) return cached;
    if (issues.size >= 1000) throw new TaskImportError("DEPENDENCY_LIMIT");
    const issue = taskIssueSchema.parse(await deps.reader.issue(id));
    if (issue.id !== id) throw new TaskImportError("ISSUE_IDENTITY_MISMATCH");
    // Rebuild in schema order and canonicalize set-valued fields before hashing.
    issue.blockedBy = [...new Set(issue.blockedBy)].sort();
    issues.set(id, issue);
    return issue;
  };
  const roots: string[] = [];
  for (const item of items) {
    if (item.kind !== "Issue" || item.archived) continue;
    if (item.issueId === null) throw new TaskImportError("MISSING_ISSUE_ID");
    if (request.scope.kind === "list" && !request.scope.issueIds.includes(item.issueId)) continue;
    if (
      request.scope.kind === "iteration" &&
      !isTaskInScope(
        { id: item.issueId, milestoneId: null, iterations: item.iterations },
        request.scope,
      )
    )
      continue;
    const issue = await read(item.issueId);
    const sameRepository =
      issue.repository.owner.toLowerCase() === request.repository.owner.toLowerCase() &&
      issue.repository.name.toLowerCase() === request.repository.name.toLowerCase();
    if (
      sameRepository &&
      isTaskImportable({ ...issue, kind: item.kind, archived: item.archived }) &&
      isTaskInScope({ ...issue, iterations: item.iterations }, request.scope)
    )
      roots.push(issue.id);
  }
  // Only retain chosen tasks and evidence needed to classify their predecessors.
  const closure = new Map<string, TaskIssue>();
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (id === undefined || closure.has(id)) continue;
    const issue = await read(id);
    closure.set(id, issue);
    queue.push(...issue.blockedBy);
  }
  const problems = validateTaskDependencies(
    [...closure.values()].map((issue) => ({
      id: issue.id,
      status: "pending",
      blockedBy: issue.blockedBy,
    })),
  );
  if (problems.length > 0)
    throw new TaskImportError(problems[0]?.code ?? "INVALID_DEPENDENCIES", problems);
  const snapshots = [...closure.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((issue) => {
      const content = { schemaVersion: 1 as const, issue };
      return taskSnapshotSchema.parse({
        ...content,
        contentHash: deps.hasher.sha256(JSON.stringify(content)),
      });
    });
  return { ...request, items, snapshots };
}
