/**
 * The "2 + Architect + 2" rework controller (product overview §10, architecture.md §9,
 * design-patterns.md §4). It owns the quality budget of one task's quality cycle:
 *
 *   normal --2nd failed cycle--> architect --solution--> assisted --2nd failed cycle--> blocked
 *   normal | assisted --gate passed--> passed          architect --no solution--> blocked
 *
 * Rules the table below enforces:
 * - A failed cycle is one implement/fix round judged not good enough; many failed gates or
 *   findings inside the same cycle count once (`cycleId` is remembered).
 * - Only quality failures count. Limits, network loss, a dead session and waiting for a PO
 *   decision are operational (retry-policy.ts) and are refused here without touching the count.
 * - The state holds no profile, model or executor, so switching them cannot reset the counter.
 * - After the second failure following the Architect, the task is blocked, not retried.
 * - A PO reopen starts a fresh count and keeps the earlier decisions in the history.
 */

export type ReworkPhase = "normal" | "architect" | "assisted" | "blocked" | "passed";

/** Failed cycles allowed before the Architect, and after the Architect. */
export const FAILURES_BEFORE_ARCHITECT = 2;
export const FAILURES_AFTER_ARCHITECT = 2;

export interface ReworkState {
  readonly phase: ReworkPhase;
  /** Failed cycles in the current segment: before the Architect, or after the Architect. */
  readonly failedCycles: number;
  readonly architectInterventionId?: string;
  /**
   * Every cycle that was counted, across phases and reopens. A late or repeated report of any of
   * them is not counted again, so an old event cannot spend the budget after the Architect.
   */
  readonly countedCycleIds: readonly string[];
  /** Ids of the PO decisions that reopened this quality cycle, oldest first. */
  readonly reopenDecisionIds: readonly string[];
}

export const INITIAL_REWORK_STATE: ReworkState = {
  phase: "normal",
  failedCycles: 0,
  countedCycleIds: [],
  reopenDecisionIds: [],
};

export type FailureKind = "quality" | "infrastructure" | "awaiting_decision";

export type ReworkEvent =
  | { readonly type: "cycle_failed"; readonly cycleId: string; readonly kind: FailureKind }
  | { readonly type: "gate_passed" }
  | {
      readonly type: "architect_solution_accepted";
      readonly interventionId: string;
      /** The solution changes business scope or cost, so it needs a valid PO approval first. */
      readonly changesBusinessOrCost: boolean;
      readonly approvalValid: boolean;
    }
  | { readonly type: "architect_no_solution" }
  | { readonly type: "po_reopened"; readonly poDecisionId: string };

export type ReworkRefusal =
  | "TRANSITION_NOT_ALLOWED"
  | "INFRASTRUCTURE_FAILURE_NOT_QUALITY"
  | "AWAITING_DECISION_NOT_QUALITY"
  | "CYCLE_ALREADY_COUNTED"
  | "INTERVENTION_ID_MISSING"
  | "APPROVAL_REQUIRED"
  | "REOPEN_DECISION_MISSING";

export type ReworkOutcome =
  | { readonly ok: true; readonly state: ReworkState }
  | { readonly ok: false; readonly reason: ReworkRefusal };

const refuse = (reason: ReworkRefusal): ReworkOutcome => ({ ok: false, reason });
const accept = (state: ReworkState): ReworkOutcome => ({ ok: true, state });

/** Next phase when a counted failure lands in `phase`, and the budget of that phase. */
function afterCountedFailure(state: ReworkState, cycleId: string): ReworkState {
  const failedCycles = state.failedCycles + 1;
  const counted = {
    ...state,
    failedCycles,
    countedCycleIds: [...state.countedCycleIds, cycleId],
  };
  if (state.phase === "normal" && failedCycles >= FAILURES_BEFORE_ARCHITECT) {
    return { ...counted, phase: "architect" };
  }
  if (state.phase === "assisted" && failedCycles >= FAILURES_AFTER_ARCHITECT) {
    return { ...counted, phase: "blocked" };
  }
  return counted;
}

export function transitionRework(state: ReworkState, event: ReworkEvent): ReworkOutcome {
  switch (event.type) {
    case "cycle_failed": {
      if (state.phase !== "normal" && state.phase !== "assisted") {
        return refuse("TRANSITION_NOT_ALLOWED");
      }
      if (event.kind === "infrastructure") return refuse("INFRASTRUCTURE_FAILURE_NOT_QUALITY");
      if (event.kind === "awaiting_decision") return refuse("AWAITING_DECISION_NOT_QUALITY");
      if (state.countedCycleIds.includes(event.cycleId)) return refuse("CYCLE_ALREADY_COUNTED");
      return accept(afterCountedFailure(state, event.cycleId));
    }
    case "gate_passed": {
      if (state.phase !== "normal" && state.phase !== "assisted") {
        return refuse("TRANSITION_NOT_ALLOWED");
      }
      return accept({ ...state, phase: "passed" });
    }
    case "architect_solution_accepted": {
      if (state.phase !== "architect") return refuse("TRANSITION_NOT_ALLOWED");
      if (event.interventionId.trim() === "") return refuse("INTERVENTION_ID_MISSING");
      if (event.changesBusinessOrCost && !event.approvalValid) return refuse("APPROVAL_REQUIRED");
      return accept({
        phase: "assisted",
        failedCycles: 0,
        architectInterventionId: event.interventionId,
        countedCycleIds: state.countedCycleIds,
        reopenDecisionIds: state.reopenDecisionIds,
      });
    }
    case "architect_no_solution": {
      if (state.phase !== "architect") return refuse("TRANSITION_NOT_ALLOWED");
      return accept({ ...state, phase: "blocked" });
    }
    case "po_reopened": {
      if (state.phase !== "blocked") return refuse("TRANSITION_NOT_ALLOWED");
      if (event.poDecisionId.trim() === "") return refuse("REOPEN_DECISION_MISSING");
      return accept({
        phase: "normal",
        failedCycles: 0,
        countedCycleIds: state.countedCycleIds,
        reopenDecisionIds: [...state.reopenDecisionIds, event.poDecisionId],
      });
    }
  }
}
