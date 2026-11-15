import { applyTransition, ruleBuilder } from "../shared/transition.js";
import type { TransitionOutcome, TransitionRule } from "../shared/transition.js";

/**
 * Task lifecycle as the PO sees it. Run-level detail (waiting for approval or resource, paused,
 * interrupted) lives on the workflow run and steps, not here: a task stays `in_progress` while
 * its run waits. A failed attempt is never a task state (architecture.md §8).
 *
 * `blocked_by_dependency` clears itself when the predecessor recovers; `blocked` means the
 * quality budget (2 + Architect + 2) is spent and only a PO decision reopens it.
 */
export const TASK_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "blocked_by_dependency",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskEvent =
  | {
      readonly type: "dependencies_satisfied";
      readonly dependenciesDone: boolean;
      readonly inputValid: boolean;
      readonly inScope: boolean;
    }
  | { readonly type: "run_started"; readonly otherActiveRunExists: boolean }
  | { readonly type: "run_replaced"; readonly previousRunClosed: boolean }
  | {
      readonly type: "completion_confirmed";
      readonly acceptanceMet: boolean;
      readonly changesCode: boolean;
      /** Merge into the integration branch confirmed on the remote (not the agent's claim). */
      readonly mergeConfirmed: boolean;
      /** Non-code output accepted under the workflow. */
      readonly outputAccepted: boolean;
    }
  | { readonly type: "quality_budget_exhausted"; readonly checkpointSaved: boolean }
  | { readonly type: "dependency_blocked" }
  | { readonly type: "dependency_recovered"; readonly anyPredecessorBlocked: boolean }
  | {
      readonly type: "po_reopened";
      /** Id of the recorded PO decision; the old failure history is kept, not erased. */
      readonly poDecisionId: string;
      readonly dependenciesDone: boolean;
    }
  | { readonly type: "cancelled"; readonly runStopped: boolean };

export type TaskRefusal =
  | "DEPENDENCIES_NOT_DONE"
  | "INPUT_INVALID"
  | "OUT_OF_SCOPE"
  | "ACTIVE_RUN_EXISTS"
  | "PREVIOUS_RUN_NOT_CLOSED"
  | "ACCEPTANCE_NOT_MET"
  | "MERGE_NOT_CONFIRMED"
  | "OUTPUT_NOT_ACCEPTED"
  | "CHECKPOINT_MISSING"
  | "PREDECESSOR_STILL_BLOCKED"
  | "REOPEN_DECISION_MISSING"
  | "RUN_STILL_ACTIVE";

const rule = ruleBuilder<TaskStatus, TaskEvent, TaskRefusal>();

const cancellable: readonly TaskStatus[] = [
  "pending",
  "ready",
  "in_progress",
  "blocked_by_dependency",
  "blocked",
];

export const TASK_RULES: readonly TransitionRule<TaskStatus, TaskEvent, TaskRefusal>[] = [
  rule("pending", "dependencies_satisfied", "ready", (e) => {
    if (!e.dependenciesDone) return "DEPENDENCIES_NOT_DONE";
    if (!e.inputValid) return "INPUT_INVALID";
    if (!e.inScope) return "OUT_OF_SCOPE";
    return undefined;
  }),
  rule("ready", "run_started", "in_progress", (e) =>
    e.otherActiveRunExists ? "ACTIVE_RUN_EXISTS" : undefined,
  ),
  // PO opens a replacement run only after the old one is closed (architecture.md §8).
  rule("in_progress", "run_replaced", "ready", (e) =>
    e.previousRunClosed ? undefined : "PREVIOUS_RUN_NOT_CLOSED",
  ),
  rule("in_progress", "completion_confirmed", "done", (e) => {
    if (!e.acceptanceMet) return "ACCEPTANCE_NOT_MET";
    if (e.changesCode) return e.mergeConfirmed ? undefined : "MERGE_NOT_CONFIRMED";
    return e.outputAccepted ? undefined : "OUTPUT_NOT_ACCEPTED";
  }),
  rule("in_progress", "quality_budget_exhausted", "blocked", (e) =>
    e.checkpointSaved ? undefined : "CHECKPOINT_MISSING",
  ),
  rule("pending", "dependency_blocked", "blocked_by_dependency"),
  rule("ready", "dependency_blocked", "blocked_by_dependency"),
  rule("blocked_by_dependency", "dependency_recovered", "pending", (e) =>
    e.anyPredecessorBlocked ? "PREDECESSOR_STILL_BLOCKED" : undefined,
  ),
  rule("blocked", "po_reopened", "ready", (e) => {
    if (e.poDecisionId.trim() === "") return "REOPEN_DECISION_MISSING";
    return e.dependenciesDone ? undefined : "DEPENDENCIES_NOT_DONE";
  }),
  ...cancellable.map((from) =>
    rule(from, "cancelled", "cancelled", (e) =>
      from === "in_progress" && !e.runStopped ? "RUN_STILL_ACTIVE" : undefined,
    ),
  ),
];

export function transitionTask(
  from: TaskStatus,
  event: TaskEvent,
): TransitionOutcome<TaskStatus, TaskRefusal> {
  return applyTransition(TASK_RULES, from, event);
}
