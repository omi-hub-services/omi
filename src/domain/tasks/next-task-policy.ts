import { compareTaskOrder } from "./promotion-policy.js";
import type { PromotionCandidate } from "./promotion-policy.js";

/** Board order of the Project Status options; an unknown option sorts after these. */
export const STATUS_ORDER = [
  "Backlog",
  "Ready",
  "In Progress",
  "In Review",
  "Waiting Approval",
  "Waiting Resource",
  "Blocked",
  "Done",
] as const;
const NO_STATUS = "(no status)";

const isOpenTask = (task: PromotionCandidate): boolean =>
  task.state === "OPEN" && task.workType !== "Epic";

/** Ready tasks that nothing blocks: every blocker closed and the blocker list read completely. */
export function selectUnblockedReady<T extends PromotionCandidate>(tasks: readonly T[]): T[] {
  return tasks
    .filter(
      (task) =>
        isOpenTask(task) &&
        task.status === "Ready" &&
        !task.blockersTruncated &&
        task.blockers.every((blocker) => blocker.state === "CLOSED"),
    )
    .sort(compareTaskOrder);
}

/** The task to start next: the first unblocked Ready task in the one task order. */
export function suggestNextTask<T extends PromotionCandidate>(tasks: readonly T[]): T | undefined {
  return selectUnblockedReady(tasks)[0];
}

export interface StatusGroup<T extends PromotionCandidate> {
  readonly status: string;
  readonly tasks: readonly T[];
}

/** Open non-Epic tasks by Project Status in board order; each group in task order. */
export function groupTasksByStatus<T extends PromotionCandidate>(
  tasks: readonly T[],
): StatusGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const task of tasks.filter(isOpenTask)) {
    const status = task.status ?? NO_STATUS;
    groups.set(status, [...(groups.get(status) ?? []), task]);
  }
  const rank = (status: string): number => {
    if (status === NO_STATUS) return STATUS_ORDER.length + 1;
    const index = STATUS_ORDER.findIndex((value) => value === status);
    return index === -1 ? STATUS_ORDER.length : index;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([status, members]) => ({ status, tasks: members.sort(compareTaskOrder) }));
}
