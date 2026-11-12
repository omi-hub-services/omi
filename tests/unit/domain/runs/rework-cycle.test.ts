import { describe, expect, it } from "vitest";
import { describeReworkCycle } from "../../../../src/domain/runs/rework-cycle.ts";
import {
  INITIAL_REWORK_STATE,
  type ReworkState,
} from "../../../../src/domain/runs/rework-policy.ts";

const state = (overrides: Partial<ReworkState>): ReworkState => ({
  ...INITIAL_REWORK_STATE,
  ...overrides,
});

describe("describeReworkCycle", () => {
  it("shows no rework before the first failure", () => {
    expect(describeReworkCycle(INITIAL_REWORK_STATE)).toEqual({
      phase: "before-architect",
      rework: 0,
      of: 2,
      architect: "none",
    });
  });

  it("counts the first failure as rework 1/2 before the Architect", () => {
    expect(describeReworkCycle(state({ failedCycles: 1 }))).toEqual({
      phase: "before-architect",
      rework: 1,
      of: 2,
      architect: "none",
    });
  });

  it("calls the Architect from the 2nd failure", () => {
    expect(describeReworkCycle(state({ phase: "architect", failedCycles: 2 }))).toEqual({
      phase: "architect",
      rework: 2,
      of: 2,
      architect: "needed",
    });
  });

  it("counts the failures after the Architect separately", () => {
    expect(
      describeReworkCycle(
        state({ phase: "assisted", failedCycles: 1, architectInterventionId: "arch-1" }),
      ),
    ).toEqual({ phase: "after-architect", rework: 1, of: 2, architect: "called" });
  });

  it("asks the PO after two more failures", () => {
    expect(
      describeReworkCycle(
        state({ phase: "blocked", failedCycles: 2, architectInterventionId: "arch-1" }),
      ),
    ).toEqual({ phase: "escalate-po", rework: 2, of: 2, architect: "called" });
  });

  it("asks the PO when the Architect found no solution", () => {
    expect(describeReworkCycle(state({ phase: "blocked", failedCycles: 2 }))).toMatchObject({
      phase: "escalate-po",
      architect: "no-solution",
    });
  });

  it("reports a passed gate without rework edges to draw", () => {
    expect(describeReworkCycle(state({ phase: "passed", failedCycles: 1 }))).toMatchObject({
      phase: "passed",
      architect: "none",
    });
  });
});
