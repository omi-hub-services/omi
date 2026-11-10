import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS as CONTRACT_EFFORTS } from "../../../../src/application/contracts/model-capability.ts";
import {
  EFFORT_LEVELS,
  effortRank,
  lowestSatisfyingEffort,
} from "../../../../src/domain/agents/capability.ts";

describe("capability", () => {
  it("keeps the domain effort order identical to the contract's (ADR-0016)", () => {
    expect([...EFFORT_LEVELS]).toEqual([...CONTRACT_EFFORTS]);
  });

  it("ranks efforts low < medium < high < xhigh < max", () => {
    const ranks = EFFORT_LEVELS.map(effortRank);
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it("picks the lowest supported effort at or above the minimum", () => {
    expect(lowestSatisfyingEffort({ minEffort: "high" }, ["max", "medium", "xhigh"])).toBe("xhigh");
    expect(lowestSatisfyingEffort({ minEffort: "high" }, ["high"])).toBe("high");
  });

  it("returns undefined when no supported effort reaches the minimum", () => {
    expect(lowestSatisfyingEffort({ minEffort: "xhigh" }, ["low", "high"])).toBeUndefined();
    expect(lowestSatisfyingEffort({ minEffort: "low" }, [])).toBeUndefined();
  });
});
