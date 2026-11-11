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
  const memo = new Map<string, DependencyState>();
  const visiting = new Set<string>();
  function classify(current: TaskNode): DependencyState {
    const cached = memo.get(current.id);
    if (cached !== undefined) return cached;
    // Validation reports the cycle; classification must also terminate on malformed graphs.
    if (visiting.has(current.id)) return { kind: "blocked", blockedOn: [current.id] };
    visiting.add(current.id);
    const blockedOn: string[] = [];
    const waitingOn: string[] = [];
    for (const dependencyId of current.blockedBy) {
      const predecessor = byId.get(dependencyId);
      const status = predecessor?.status;
      if (status === "done") continue;
      if (
        status === "blocked" ||
        status === "blocked_by_dependency" ||
        status === "cancelled" ||
        (predecessor !== undefined && classify(predecessor).kind === "blocked")
      )
        blockedOn.push(dependencyId);
      else waitingOn.push(dependencyId);
    }
    visiting.delete(current.id);
    const state: DependencyState =
      blockedOn.length > 0
        ? { kind: "blocked", blockedOn }
        : waitingOn.length > 0
          ? { kind: "waiting", waitingOn }
          : { kind: "satisfied" };
    memo.set(current.id, state);
    return state;
  }
  return classify(task);
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

export interface SchedulingTask extends TaskNode {
  /** Trusted Project priority, never parsed from Issue prose. Missing priority sorts last. */
  readonly priority: "P0" | "P1" | "P2" | null;
  readonly eligible: boolean;
}

export interface SchedulingCapacity {
  /** Includes active tasks outside the current PO scope and pending reservations. */
  readonly activeTaskIds: readonly string[];
  /** Project-wide pending reservations plus running workers, including read-only workers. */
  readonly activeWorkers: number;
  readonly maxTasks: number;
  readonly maxWorkers: number;
}

/**
 * Plans one worker for each newly admitted task. The runtime serializes selection and records
 * reservations before the next tick. Profile/account capacity is reserved by selectExecutor;
 * worktree writers are acquired by dispatchStep through the existing fenced lease.
 */
export function selectTaskBatch(
  tasks: readonly SchedulingTask[],
  capacity: SchedulingCapacity,
): readonly string[] {
  if (
    !Number.isSafeInteger(capacity.activeWorkers) ||
    capacity.activeWorkers < 0 ||
    !Number.isSafeInteger(capacity.maxTasks) ||
    capacity.maxTasks < 1 ||
    !Number.isSafeInteger(capacity.maxWorkers) ||
    capacity.maxWorkers < 1
  )
    throw new RangeError("Invalid scheduling capacity");
  const problems = validateTaskDependencies(tasks);
  if (problems.length > 0) throw new RangeError(problems[0]?.code);
  const active = new Set(capacity.activeTaskIds);
  for (const task of tasks) if (task.status === "in_progress") active.add(task.id);
  const available = Math.max(
    0,
    Math.min(capacity.maxTasks - active.size, capacity.maxWorkers - capacity.activeWorkers),
  );
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rank = { P0: 0, P1: 1, P2: 2 };
  return tasks
    .filter(
      (task) =>
        task.eligible &&
        task.status === "ready" &&
        !active.has(task.id) &&
        classifyDependencies(task, byId).kind === "satisfied",
    )
    .sort(
      (a, b) =>
        (a.priority === null ? 3 : rank[a.priority]) -
          (b.priority === null ? 3 : rank[b.priority]) || a.id.localeCompare(b.id),
    )
    .slice(0, available)
    .map((task) => task.id);
}
