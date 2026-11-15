import { describe, expect, it } from "vitest";
import { roleSchema, ruleMetadataSchema } from "../../../../src/application/contracts/role.ts";

const valid = {
  schema_version: 1,
  id: "developer",
  version: 1,
  title: "Developer",
  description: "Implements.",
  skills: ["minimal-change"],
  rules: [],
};

// AC-1: a role must not lock a tool or model.
describe("roleSchema", () => {
  it("accepts a role and defaults missing skills and rules to empty", () => {
    expect(roleSchema.parse(valid)).toEqual(valid);
    const bare = {
      schema_version: 1,
      id: "qa",
      version: 1,
      title: "QA",
      description: "Verifies.",
    };
    expect(roleSchema.parse(bare)).toMatchObject({ skills: [], rules: [] });
  });

  it("declares no field that could bind execution", () => {
    const fields = Object.keys(roleSchema.shape);
    for (const forbidden of ["tool", "model", "profile", "executor", "capability_profile"]) {
      expect(fields).not.toContain(forbidden);
    }
    expect(fields.sort()).toEqual(
      ["description", "id", "rules", "schema_version", "skills", "title", "version"].sort(),
    );
  });

  it.each([
    "tool",
    "tools",
    "model",
    "model_alias",
    "profile",
    "executor",
    "capability_profile",
    "allowed_tools",
  ])("rejects a role that sets %s", (field) => {
    expect(roleSchema.safeParse({ ...valid, [field]: "claude-code" }).success).toBe(false);
  });

  it("rejects duplicate or malformed references", () => {
    expect(roleSchema.safeParse({ ...valid, skills: ["a", "a"] }).success).toBe(false);
    expect(roleSchema.safeParse({ ...valid, rules: ["Not A Slug"] }).success).toBe(false);
    expect(roleSchema.safeParse({ ...valid, schema_version: 2 }).success).toBe(false);
  });
});

describe("ruleMetadataSchema", () => {
  it("requires an explicit mandatory flag and rejects extra fields", () => {
    expect(ruleMetadataSchema.safeParse({ id: "r", version: 1 }).success).toBe(false);
    expect(
      ruleMetadataSchema.safeParse({ id: "r", version: 1, mandatory: true, model: "x" }).success,
    ).toBe(false);
    expect(ruleMetadataSchema.parse({ id: "r", version: 1, mandatory: true }).mandatory).toBe(true);
  });
});
