import {
  classifyDependencies,
  isTaskImportable,
  isTaskInScope,
  validateTaskDependencies,
} from "../../../domain/tasks/dependency-policy.js";
import type { TaskNode } from "../../../domain/tasks/dependency-policy.js";
import { selectReadyTasksSchema } from "../../contracts/task-import.js";
import type { ImportedTasks } from "../../contracts/task-import.js";
import { TaskImportError } from "../../ports/github-task-reader.js";

/** Select from the current scope on every call; closure-only snapshots are never candidates. */
export function selectReadyTasks(input: unknown): ImportedTasks["snapshots"] {
  const { imported, states } = selectReadyTasksSchema.parse(input);
  const statuses = new Map(states.map((state) => [state.id, state.status]));
  if (statuses.size !== states.length) throw new TaskImportError("DUPLICATE_TASK_STATE");
  const nodes: TaskNode[] = imported.snapshots.map(({ issue }) => ({
    id: issue.id,
    status: statuses.get(issue.id) ?? "pending",
    blockedBy: issue.blockedBy,
  }));
  const problems = validateTaskDependencies(nodes);
  if (problems.length > 0)
    throw new TaskImportError(problems[0]?.code ?? "INVALID_DEPENDENCIES", problems);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return imported.snapshots.filter(({ issue }) => {
    const node = byId.get(issue.id);
    return (
      node !== undefined &&
      (node.status === "pending" || node.status === "ready") &&
      issue.repository.owner.toLowerCase() === imported.repository.owner.toLowerCase() &&
      issue.repository.name.toLowerCase() === imported.repository.name.toLowerCase() &&
      imported.items.some(
        (item) =>
          item.issueId === issue.id &&
          isTaskImportable({ ...issue, kind: item.kind, archived: item.archived }) &&
          isTaskInScope({ ...issue, iterations: item.iterations }, imported.scope),
      ) &&
      classifyDependencies(node, byId).kind === "satisfied"
    );
  });
}
