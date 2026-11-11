import { describe, expect, it } from "vitest";
import { inferComplexity, type EffortInput } from "../../../../tools/coordinator/effort-policy.ts";

const task: EffortInput = {
  workflow: "feature",
  workType: "Task",
  area: "runtime",
  priority: "P1",
  acCount: 4,
  labels: [],
};

const decide = (over: Partial<EffortInput>) => inferComplexity({ ...task, ...over });

describe("inferComplexity", () => {
  it.each([{ workflow: "docs" }, { workType: "Docs" }])("uses low for docs: %j", (over) => {
    expect(decide(over).complexity).toBe("low");
  });

  it.each(["feature", "bugfix", "refactor"])("uses medium for %s runtime work", (workflow) => {
    expect(decide({ workflow }).complexity).toBe("medium");
  });

  it.each([{ workflow: "research" }, { workType: "Spike" }, { workType: "PoC" }])(
    "uses high for research/PoC: %j",
    (over) => {
      expect(decide(over).complexity).toBe("high");
    },
  );

  it("only raises P0 above five top-level AC, before the docs rule", () => {
    expect(decide({ priority: "P0", acCount: 5 }).complexity).toBe("medium");
    expect(decide({ priority: "P0", acCount: 6, workflow: "docs" }).complexity).toBe("high");
    expect(decide({ priority: "P1", acCount: 6 }).complexity).toBe("medium");
  });

  it.each(["runtime", "adapters", "github"])("requires live tests to raise %s to high", (area) => {
    expect(decide({ area, hasLiveTests: true }).complexity).toBe("high");
    expect(decide({ area, hasLiveTests: false }).complexity).toBe("medium");
  });

  it("uses low for small non-runtime work, never inferring low from zero AC", () => {
    expect(decide({ area: "tooling", acCount: 3 }).complexity).toBe("low");
    expect(decide({ area: "tooling", acCount: 4 }).complexity).toBe("medium");
    expect(decide({ area: "tooling", acCount: 0 }).complexity).toBe("medium");
    expect(decide({ area: "domain", acCount: 3 }).complexity).toBe("medium");
  });

  it.each(["low", "medium", "high"] as const)(
    "lets the %s label override all rules",
    (complexity) => {
      expect(decide({ workflow: null, labels: [`complexity:${complexity}`] })).toEqual({
        complexity,
        reason: `label complexity:${complexity}`,
      });
      expect(
        decide({ workflow: "research", labels: [`complexity:${complexity}`] }).complexity,
      ).toBe(complexity);
    },
  );

  it("resolves conflicting labels by highest complexity regardless of order", () => {
    for (const labels of [
      ["complexity:low", "complexity:high"],
      ["complexity:high", "complexity:low"],
    ]) {
      expect(decide({ labels }).complexity).toBe("high");
    }
    expect(decide({ labels: ["complexity:unknown", "please use low"] }).complexity).toBe("medium");
  });

  it.each(["workflow", "workType", "area", "priority"] as const)(
    "defaults to medium for missing %s",
    (field) => {
      for (const value of [null, "", " "]) {
        expect(decide({ workflow: "research", [field]: value })).toMatchObject({
          complexity: "medium",
          reason: expect.stringMatching(/missing Project fields: .+; default medium/) as unknown,
        });
      }
    },
  );
});
