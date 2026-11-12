import { taskReadinessReasons, type TaskReadinessInput } from "./readiness-gate.js";

export interface TaskBlocker {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
}

export interface PromotionCandidate extends TaskReadinessInput {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
  /** Project Status option name, e.g. `Backlog`. */
  readonly status: string | null;
  readonly milestone: string | null;
  /** Native "blocked by" Issues. */
  readonly blockers: readonly TaskBlocker[];
  /** More blockers exist than were read; treated as blocked. */
  readonly blockersTruncated: boolean;
}

export type Promotion =
  | { readonly kind: "promote" }
  | { readonly kind: "done"; readonly note: string }
  | { readonly kind: "refuse"; readonly reason: string };

const PRIORITY_ORDER = ["P0", "P1", "P2"];
const priorityRank = (priority: string | null): number => {
  const index = PRIORITY_ORDER.indexOf(priority ?? "");
  return index === -1 ? PRIORITY_ORDER.length : index;
};

/** Titles sort alphabetically; an Issue without a milestone comes after every milestone. */
function compareMilestone(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b);
}

/** Backlog → Ready: only a Backlog Issue with every blocker closed that passes the gate. */
export function judgePromotion(task: PromotionCandidate): Promotion {
  const id = `#${String(task.number)}`;
  if (task.workType === "Epic") return { kind: "refuse", reason: `${id} is an Epic` };
  if (task.state === "CLOSED") return { kind: "refuse", reason: `${id} is closed` };
  if (task.status === "Ready") return { kind: "done", note: `${id} Status is already Ready` };
  if (task.status !== "Backlog")
    return { kind: "refuse", reason: `${id} is ${task.status ?? "(none)"}, not Backlog` };
  const reasons: string[] = [];
  const open = task.blockers.filter((b) => b.state !== "CLOSED").map((b) => `#${String(b.number)}`);
  if (open.length > 0) reasons.push(`blocked by ${open.join(", ")}`);
  else if (task.blockersTruncated) reasons.push("more blockers than could be read");
  reasons.push(...taskReadinessReasons(task));
  return reasons.length > 0
    ? { kind: "refuse", reason: `${id}: ${reasons.join("; ")}` }
    : { kind: "promote" };
}

/** Issues `judgePromotion` accepts, ordered by Priority, milestone title, then Issue number. */
export function selectPromotable(tasks: readonly PromotionCandidate[]): PromotionCandidate[] {
  return tasks
    .filter((task) => judgePromotion(task).kind === "promote")
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        compareMilestone(a.milestone, b.milestone) ||
        a.number - b.number,
    );
}
