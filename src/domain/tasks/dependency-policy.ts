import { findDependencyCycle } from "../shared/graph.js";
import type { TaskStatus } from "./task-status.js";

export interface TaskNode {
  readonly id: string;
  readonly status: TaskStatus;
  /** Ids of the tasks that must be done first (the Issue's native "blocked by"). */
  readonly blockedBy: readonly string[];
}

export type DependencyIssue =
  | { readonly code: "DUPLICATE_TASK"; readonly taskId: string }
  | { readonly code: "UNKNOWN_DEPENDENCY"; readonly taskId: string; readonly dependencyId: string }
  | { readonly code: "SELF_DEPENDENCY"; readonly taskId: string }
  | { readonly code: "DEPENDENCY_CYCLE"; readonly path: readonly string[] };

/** Product overview §9.1: a dependency cycle blocks assignment and names its cause. */
export function validateTaskDependencies(tasks: readonly TaskNode[]): readonly DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      issues.push({ code: "DUPLICATE_TASK", taskId: task.id });
    }
    ids.add(task.id);
  }
  const graph = new Map<string, readonly string[]>();
  for (const task of tasks) {
    graph.set(task.id, task.blockedBy);
    for (const dependencyId of task.blockedBy) {
      if (dependencyId === task.id) {
        issues.push({ code: "SELF_DEPENDENCY", taskId: task.id });
      } else if (!ids.has(dependencyId)) {
        issues.push({ code: "UNKNOWN_DEPENDENCY", taskId: task.id, dependencyId });
      }
    }
  }
  const selfFree = new Map(
    [...graph].map(([id, deps]) => [id, deps.filter((dep) => dep !== id)] as const),
  );
  const cycle = findDependencyCycle(selfFree);
  if (cycle !== undefined) {
    issues.push({ code: "DEPENDENCY_CYCLE", path: cycle });
  }
  return issues;
}

export type DependencyState =
  | { readonly kind: "satisfied" }
  | { readonly kind: "waiting"; readonly waitingOn: readonly string[] }
  | { readonly kind: "blocked"; readonly blockedOn: readonly string[] };

/**
 * Classifies a task by its predecessors. A predecessor that is `blocked`/`blocked_by_dependency`
 * (or cancelled, which can never become done) blocks its dependents; the dependents of one
 * stopped task are blocked while independent tasks carry on (product overview §10).
 * An unknown predecessor is treated as waiting: the graph must be validated first.
 */
export function classifyDependencies(
  task: TaskNode,
  byId: ReadonlyMap<string, TaskNode>,
): DependencyState {
  const blockedOn: string[] = [];
  const waitingOn: string[] = [];
  for (const dependencyId of task.blockedBy) {
    const status = byId.get(dependencyId)?.status;
    if (status === "done") continue;
    if (status === "blocked" || status === "blocked_by_dependency" || status === "cancelled") {
      blockedOn.push(dependencyId);
    } else {
      waitingOn.push(dependencyId);
    }
  }
  if (blockedOn.length > 0) return { kind: "blocked", blockedOn };
  if (waitingOn.length > 0) return { kind: "waiting", waitingOn };
  return { kind: "satisfied" };
}

export type TaskScope =
  | { readonly kind: "milestone"; readonly milestoneId: string }
  | { readonly kind: "iteration"; readonly fieldId: string; readonly iterationId: string }
  | { readonly kind: "list"; readonly issueIds: readonly string[] };

export interface TaskScopeFacts {
  readonly id: string;
  readonly milestoneId: string | null;
  readonly iterations: readonly { readonly fieldId: string; readonly iterationId: string }[];
}

/** IDs only: names, body references and dependency reachability never expand the scope. */
export function isTaskInScope(task: TaskScopeFacts, scope: TaskScope): boolean {
  switch (scope.kind) {
    case "milestone":
      return task.milestoneId === scope.milestoneId;
    case "iteration":
      return task.iterations.some(
        (value) => value.fieldId === scope.fieldId && value.iterationId === scope.iterationId,
      );
    case "list":
      return scope.issueIds.includes(task.id);
  }
}

/** Minimum import eligibility (ADR-0032); semantic readiness and approvals remain separate gates. */
export function isTaskImportable(task: {
  readonly kind: string;
  readonly archived: boolean;
  readonly state: string;
  readonly title: string;
  readonly body: string;
}): boolean {
  return (
    task.kind === "Issue" &&
    !task.archived &&
    task.state === "OPEN" &&
    task.title.trim() !== "" &&
    task.body.trim() !== ""
  );
}
