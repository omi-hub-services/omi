import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../../../../src/application/contracts/project-config.ts";
import { taskComplexitySchema } from "../../../../src/application/contracts/task-complexity.ts";
import { baseline } from "../../../fixtures/github/project-mapping.ts";

describe("complexity configuration boundary", () => {
  it("defaults older project.yaml files and preserves explicit project mappings", () => {
    const { effort_policy: ignored, ...legacy } = baseline;
    expect(ignored).toEqual({ low: "low", medium: "medium", high: "high" });
    expect(projectConfigSchema.parse(legacy).effort_policy).toEqual(ignored);
    expect(
      projectConfigSchema.parse({
        ...legacy,
        effort_policy: { low: "medium", medium: "high", high: "max" },
      }).effort_policy.high,
    ).toBe("max");
  });
  it("rejects invalid efforts, unknown mappings, invalid overrides and noninteger counts", () => {
    expect(
      projectConfigSchema.safeParse({
        ...baseline,
        effort_policy: { low: "minimal", medium: "medium", high: "high" },
      }).success,
    ).toBe(false);
    expect(
      projectConfigSchema.safeParse({
        ...baseline,
        effort_policy: { ...baseline.effort_policy, secret: "x" },
      }).success,
    ).toBe(false);
    expect(taskComplexitySchema.safeParse({ complexity: "extreme" }).success).toBe(false);
    expect(taskComplexitySchema.safeParse({ acCount: -1 }).success).toBe(false);
    expect(taskComplexitySchema.safeParse({ acCount: 1.5 }).success).toBe(false);
  });
});
