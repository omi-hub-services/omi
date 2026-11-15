import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../../../../src/application/contracts/project-config.ts";

const base = {
  schema_version: 1,
  repository: { owner: "acme", name: "app" },
  project: { owner: "acme", number: 1 },
  branches: { integration: "develop", release: "main" },
  limits: { max_parallel_workers: 2, step_timeout_seconds: 60, max_rework_cycles: 2 },
  effort_policy: { low: "low", medium: "medium", high: "high" },
  policies: { mandatory_approvals: [] },
};
const target = {
  id: "sandbox-r1",
  target_environment: "sandbox",
  artifact_digest: `sha256:${"a".repeat(64)}`,
};

describe("project config deploy_targets", () => {
  it("is optional, so older configs stay valid", () => {
    expect(projectConfigSchema.parse(base).deploy_targets).toBeUndefined();
  });

  it("accepts a strict target list", () => {
    expect(projectConfigSchema.parse({ ...base, deploy_targets: [target] }).deploy_targets).toEqual(
      [target],
    );
  });

  it.each([
    ["a duplicate id", [target, { ...target, target_environment: "staging" }]],
    ["a mutable tag instead of a digest", [{ ...target, artifact_digest: "latest" }]],
    ["an uppercase digest", [{ ...target, artifact_digest: `sha256:${"A".repeat(64)}` }]],
    ["an unknown key", [{ ...target, approved: true }]],
    ["a missing environment", [{ id: target.id, artifact_digest: target.artifact_digest }]],
  ])("rejects %s", (_name, deploy_targets) => {
    expect(projectConfigSchema.safeParse({ ...base, deploy_targets }).success).toBe(false);
  });
});
