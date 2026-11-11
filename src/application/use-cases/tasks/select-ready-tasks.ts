import {
  selectTaskBatch,
  isTaskImportable,
  isTaskInScope,
  validateTaskDependencies,
} from "../../../domain/tasks/dependency-policy.js";
import type { SchedulingTask } from "../../../domain/tasks/dependency-policy.js";
import { selectReadyTasksSchema } from "../../contracts/task-import.js";
import type { ImportedTasks } from "../../contracts/task-import.js";
import { TaskImportError } from "../../ports/github-task-reader.js";

/** Select from the current scope on every call; closure-only snapshots are never candidates. */
export function selectReadyTasks(input: unknown): ImportedTasks["snapshots"] {
  const { imported, states, activeTaskIds, activeWorkers, limits } =
    selectReadyTasksSchema.parse(input);
  const statuses = new Map(states.map((state) => [state.id, state.status]));
  if (statuses.size !== states.length) throw new TaskImportError("DUPLICATE_TASK_STATE");
  const priorities = new Map(states.map((state) => [state.id, state.priority]));
  const nodes: SchedulingTask[] = imported.snapshots.map(({ issue }) => ({
    id: issue.id,
    status: statuses.get(issue.id) ?? "pending",
    blockedBy: issue.blockedBy,
    priority: priorities.get(issue.id) ?? null,
    eligible: eligible(issue.id),
  }));
  const problems = validateTaskDependencies(nodes);
  if (problems.length > 0)
    throw new TaskImportError(problems[0]?.code ?? "INVALID_DEPENDENCIES", problems);
  const selected = selectTaskBatch(nodes, {
    activeTaskIds: [
      ...activeTaskIds,
      ...states.filter((state) => state.status === "in_progress").map((state) => state.id),
    ],
    activeWorkers,
    ...limits,
  });
  const snapshots = new Map(imported.snapshots.map((snapshot) => [snapshot.issue.id, snapshot]));
  return selected.flatMap((id) => {
    const snapshot = snapshots.get(id);
    return snapshot === undefined ? [] : [snapshot];
  });

  function eligible(id: string): boolean {
    const issue = imported.snapshots.find((snapshot) => snapshot.issue.id === id)?.issue;
    return (
      issue !== undefined &&
      issue.repository.owner.toLowerCase() === imported.repository.owner.toLowerCase() &&
      issue.repository.name.toLowerCase() === imported.repository.name.toLowerCase() &&
      imported.items.some(
        (item) =>
          item.issueId === issue.id &&
          isTaskImportable({ ...issue, kind: item.kind, archived: item.archived }) &&
          isTaskInScope({ ...issue, iterations: item.iterations }, imported.scope),
      )
    );
  }
}
