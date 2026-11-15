import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../../../../src/application/contracts/project-config.ts";
import { workflowSchema } from "../../../../src/application/contracts/workflow.ts";

const base = {
  schema_version: 1,
  repository: { owner: "acme", name: "app" },
  project: { owner: "acme", number: 1 },
  branches: { integration: "develop", release: "main" },
  limits: { max_parallel_workers: 2, step_timeout_seconds: 60, max_rework_cycles: 2 },
  effort_policy: { low: "low", medium: "medium", high: "high" },
  policies: { mandatory_approvals: [] },
};

describe("project config checks block", () => {
  it("is absent for older configs, so they stay valid and keep their hash", () => {
    expect(projectConfigSchema.parse(base).checks).toBeUndefined();
  });

  it("maps a check id to an argv command and fills a default timeout", () => {
    const config = projectConfigSchema.parse({
      ...base,
      checks: { "project-check": { command: ["npm", "run", "check"] } },
    });
    expect(config.checks).toEqual({
      "project-check": { command: ["npm", "run", "check"], timeout_seconds: 600 },
    });
  });

  it.each([
    ["an empty command", { command: [] }],
    ["a shell string instead of argv", { command: "npm run check" }],
    ["an unknown field", { command: ["npm"], shell: true }],
    ["a zero timeout", { command: ["npm"], timeout_seconds: 0 }],
  ])("rejects %s", (_name, check) => {
    expect(projectConfigSchema.safeParse({ ...base, checks: { unit: check } }).success).toBe(false);
  });
});

describe("workflow step required_checks", () => {
  const workflow = {
    schema_version: 1,
    id: "feature",
    version: 1,
    selection: { task_types: ["feature"] },
    quality_policy: "task-default",
    steps: [
      {
        id: "verify",
        role: "qa",
        needs: [],
        capability_profile: "testing",
        output_contract: "verification-result-v1",
      },
    ],
  };

  it("defaults to none", () => {
    expect(workflowSchema.parse(workflow).steps[0]?.required_checks).toEqual([]);
  });

  it("lists check ids and rejects a malformed id", () => {
    const withChecks = (ids: string[]) => ({
      ...workflow,
      steps: [{ ...workflow.steps[0], required_checks: ids }],
    });
    expect(workflowSchema.parse(withChecks(["project-check"])).steps[0]?.required_checks).toEqual([
      "project-check",
    ]);
    expect(workflowSchema.safeParse(withChecks(["Not A Slug"])).success).toBe(false);
  });
});
