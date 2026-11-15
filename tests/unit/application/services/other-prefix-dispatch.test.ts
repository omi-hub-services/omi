import { describe, expect, it } from "vitest";
import { dispatchTaskSchema } from "../../../../src/application/services/plan-step-dispatch.ts";

describe("dispatch workspace identity for a Plan Key prefix other than OMI", () => {
  const parse = (taskId: string) =>
    dispatchTaskSchema.shape.workspace.safeParse({ taskId, slug: "bn-001" }).success;

  it("accepts bn-001 and still rejects unsafe or uppercase ids", () => {
    expect(parse("bn-001")).toBe(true);
    expect(parse("../bn-001")).toBe(false);
    expect(parse("BN-001")).toBe(false);
  });
});
