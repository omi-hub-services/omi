import { FAILURES_AFTER_ARCHITECT, FAILURES_BEFORE_ARCHITECT } from "./rework-policy.js";
import type { ReworkState } from "./rework-policy.js";

/**
 * How a run's rework controller state reads on a card: the "2 + Architect + 2" cycle seen from the
 * runtime's own state, never from comments. Pure view of `ReworkState`; it decides nothing.
 */
export type ReworkCyclePhase =
  "before-architect" | "architect" | "after-architect" | "escalate-po" | "passed";

export interface ReworkCycle {
  readonly phase: ReworkCyclePhase;
  /** Failed cycles of the current segment (before, or after, the Architect). */
  readonly rework: number;
  /** The budget of that segment. */
  readonly of: number;
  readonly architect: "none" | "needed" | "called" | "no-solution";
}

export function describeReworkCycle(state: ReworkState): ReworkCycle {
  const called = state.architectInterventionId !== undefined;
  switch (state.phase) {
    case "normal":
      return {
        phase: "before-architect",
        rework: state.failedCycles,
        of: FAILURES_BEFORE_ARCHITECT,
        architect: "none",
      };
    case "architect":
      return {
        phase: "architect",
        rework: state.failedCycles,
        of: FAILURES_BEFORE_ARCHITECT,
        architect: "needed",
      };
    case "assisted":
      return {
        phase: "after-architect",
        rework: state.failedCycles,
        of: FAILURES_AFTER_ARCHITECT,
        architect: "called",
      };
    case "blocked":
      return {
        phase: "escalate-po",
        rework: state.failedCycles,
        of: called ? FAILURES_AFTER_ARCHITECT : FAILURES_BEFORE_ARCHITECT,
        architect: called ? "called" : "no-solution",
      };
    case "passed":
      return {
        phase: "passed",
        rework: state.failedCycles,
        of: called ? FAILURES_AFTER_ARCHITECT : FAILURES_BEFORE_ARCHITECT,
        architect: called ? "called" : "none",
      };
  }
}
