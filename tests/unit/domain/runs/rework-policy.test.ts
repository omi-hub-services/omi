import { describe, expect, it } from "vitest";
import {
  INITIAL_REWORK_STATE,
  transitionRework,
} from "../../../../src/domain/runs/rework-policy.ts";
import type { ReworkEvent, ReworkState } from "../../../../src/domain/runs/rework-policy.ts";

/** Applies events in order and fails the test if one is refused. */
function run(start: ReworkState, ...events: ReworkEvent[]): ReworkState {
  let state = start;
  for (const event of events) {
    const outcome = transitionRework(state, event);
    if (!outcome.ok) throw new Error(`${event.type} refused: ${outcome.reason}`);
    state = outcome.state;
  }
  return state;
}

const failed = (cycleId: string): ReworkEvent => ({
  type: "cycle_failed",
  cycleId,
  kind: "quality",
});
const solution: ReworkEvent = {
  type: "architect_solution_accepted",
  interventionId: "arch-1",
  changesBusinessOrCost: false,
  approvalValid: false,
};

describe("2 + Architect + 2", () => {
  it("allows one failed cycle without escalating", () => {
    const state = run(INITIAL_REWORK_STATE, failed("c1"));
    expect(state).toMatchObject({ phase: "normal", failedCycles: 1 });
  });

  it("escalates to the Architect on the second failed cycle, not before", () => {
    const state = run(INITIAL_REWORK_STATE, failed("c1"), failed("c2"));
    expect(state).toMatchObject({ phase: "architect", failedCycles: 2 });
  });

  it("gives two more attempts after the Architect, then blocks", () => {
    const afterArchitect = run(INITIAL_REWORK_STATE, failed("c1"), failed("c2"), solution);
    expect(afterArchitect).toMatchObject({
      phase: "assisted",
      failedCycles: 0,
      architectInterventionId: "arch-1",
    });
    const one = run(afterArchitect, failed("c3"));
    expect(one).toMatchObject({ phase: "assisted", failedCycles: 1 });
    const two = run(one, failed("c4"));
    expect(two.phase).toBe("blocked");
  });

  it("passes from normal or assisted when the gate passes, and keeps nothing to retry", () => {
    expect(run(INITIAL_REWORK_STATE, failed("c1"), { type: "gate_passed" }).phase).toBe("passed");
    const assisted = run(INITIAL_REWORK_STATE, failed("c1"), failed("c2"), solution);
    expect(run(assisted, { type: "gate_passed" }).phase).toBe("passed");
  });

  it("blocks when the Architect has no solution", () => {
    const state = run(INITIAL_REWORK_STATE, failed("c1"), failed("c2"), {
      type: "architect_no_solution",
    });
    expect(state.phase).toBe("blocked");
  });

  describe("counting", () => {
    it("counts several failed gates of one cycle once", () => {
      const first = run(INITIAL_REWORK_STATE, failed("c1"));
      expect(transitionRework(first, failed("c1"))).toEqual({
        ok: false,
        reason: "CYCLE_ALREADY_COUNTED",
      });
      expect(first.failedCycles).toBe(1);
    });

    it("does not count a late repeat of an earlier cycle after the Architect step", () => {
      const afterArchitect = run(INITIAL_REWORK_STATE, failed("c1"), failed("c2"), solution);
      for (const late of ["c1", "c2"]) {
        expect(transitionRework(afterArchitect, failed(late))).toEqual({
          ok: false,
          reason: "CYCLE_ALREADY_COUNTED",
        });
      }
      // Only genuinely new cycles spend the post-Architect budget.
      expect(run(afterArchitect, failed("c3"))).toMatchObject({
        phase: "assisted",
        failedCycles: 1,
      });
    });

    it("keeps counted cycles across a PO reopen, so an old event cannot hit the fresh budget", () => {
      const blocked = run(
        INITIAL_REWORK_STATE,
        failed("c1"),
        failed("c2"),
        solution,
        failed("c3"),
        failed("c4"),
      );
      const reopened = run(blocked, { type: "po_reopened", poDecisionId: "po-1" });
      expect(transitionRework(reopened, failed("c4"))).toEqual({
        ok: false,
        reason: "CYCLE_ALREADY_COUNTED",
      });
      expect(run(reopened, failed("d1"))).toMatchObject({ phase: "normal", failedCycles: 1 });
    });

    it("does not count infrastructure failures or a wait for a PO decision", () => {
      const first = run(INITIAL_REWORK_STATE, failed("c1"));
      expect(
        transitionRework(first, { type: "cycle_failed", cycleId: "c2", kind: "infrastructure" }),
      ).toEqual({ ok: false, reason: "INFRASTRUCTURE_FAILURE_NOT_QUALITY" });
      expect(
        transitionRework(first, { type: "cycle_failed", cycleId: "c3", kind: "awaiting_decision" }),
      ).toEqual({ ok: false, reason: "AWAITING_DECISION_NOT_QUALITY" });
      // The state object the caller keeps is unchanged, so the budget is intact.
      expect(first).toMatchObject({ phase: "normal", failedCycles: 1 });
    });

    it("carries no profile or model, so changing them cannot reset the counter", () => {
      expect(Object.keys(run(INITIAL_REWORK_STATE, failed("c1"))).sort()).toEqual([
        "countedCycleIds",
        "failedCycles",
        "phase",
        "reopenDecisionIds",
      ]);
    });
  });

  describe("Architect solutions", () => {
    const atArchitect = run(INITIAL_REWORK_STATE, failed("c1"), failed("c2"));

    it("needs an intervention id", () => {
      expect(transitionRework(atArchitect, { ...solution, interventionId: " " })).toEqual({
        ok: false,
        reason: "INTERVENTION_ID_MISSING",
      });
    });

    it("needs a valid PO approval when the solution changes business scope or cost", () => {
      const costly: ReworkEvent = {
        type: "architect_solution_accepted",
        interventionId: "arch-1",
        changesBusinessOrCost: true,
        approvalValid: false,
      };
      expect(transitionRework(atArchitect, costly)).toEqual({
        ok: false,
        reason: "APPROVAL_REQUIRED",
      });
      expect(transitionRework(atArchitect, { ...costly, approvalValid: true })).toMatchObject({
        ok: true,
      });
    });
  });

  describe("invalid transitions", () => {
    it("refuses events in the wrong phase", () => {
      const atArchitect = run(INITIAL_REWORK_STATE, failed("c1"), failed("c2"));
      const blocked = run(atArchitect, { type: "architect_no_solution" });
      const passed = run(INITIAL_REWORK_STATE, { type: "gate_passed" });
      const refused = (state: ReworkState, event: ReworkEvent) => transitionRework(state, event);

      expect(refused(INITIAL_REWORK_STATE, solution)).toEqual({
        ok: false,
        reason: "TRANSITION_NOT_ALLOWED",
      });
      expect(refused(INITIAL_REWORK_STATE, { type: "architect_no_solution" }).ok).toBe(false);
      expect(refused(atArchitect, failed("c3"))).toEqual({
        ok: false,
        reason: "TRANSITION_NOT_ALLOWED",
      });
      expect(refused(atArchitect, { type: "gate_passed" }).ok).toBe(false);
      expect(refused(blocked, failed("c9")).ok).toBe(false);
      expect(refused(blocked, { type: "gate_passed" }).ok).toBe(false);
      expect(refused(passed, failed("c9")).ok).toBe(false);
      expect(refused(passed, { type: "po_reopened", poDecisionId: "d" }).ok).toBe(false);
      expect(refused(INITIAL_REWORK_STATE, { type: "po_reopened", poDecisionId: "d" }).ok).toBe(
        false,
      );
    });
  });

  describe("reopening a blocked task", () => {
    const blocked = run(
      INITIAL_REWORK_STATE,
      failed("c1"),
      failed("c2"),
      solution,
      failed("c3"),
      failed("c4"),
    );

    it("needs a recorded PO decision", () => {
      expect(transitionRework(blocked, { type: "po_reopened", poDecisionId: "" })).toEqual({
        ok: false,
        reason: "REOPEN_DECISION_MISSING",
      });
    });

    it("starts a fresh count and keeps the decision history", () => {
      const reopened = run(blocked, { type: "po_reopened", poDecisionId: "po-1" });
      expect(reopened).toEqual({
        phase: "normal",
        failedCycles: 0,
        countedCycleIds: ["c1", "c2", "c3", "c4"],
        reopenDecisionIds: ["po-1"],
      });
      const blockedAgain = run(
        reopened,
        failed("d1"),
        failed("d2"),
        solution,
        failed("d3"),
        failed("d4"),
        { type: "po_reopened", poDecisionId: "po-2" },
      );
      expect(blockedAgain.reopenDecisionIds).toEqual(["po-1", "po-2"]);
    });
  });
});
