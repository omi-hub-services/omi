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
const deploy = {
  workflow: "deploy.yml",
  tag_ref: "deploy-r1",
  workflow_sha: "b".repeat(40),
  issue_number: 48,
  allowed_actors: ["po"],
  author_actor: "omi-bot",
  allowed_repositories: ["acme/app"],
  allowed_environments: ["staging"],
};

describe("project config deploy block", () => {
  it("is optional, so older configs stay valid", () => {
    expect(projectConfigSchema.parse(base).deploy).toBeUndefined();
  });

  it("accepts the pipeline and the repository/environment allowlists", () => {
    expect(projectConfigSchema.parse({ ...base, deploy }).deploy).toEqual(deploy);
  });

  it.each([
    ["an empty repository allowlist", { ...deploy, allowed_repositories: [] }],
    ["an empty environment allowlist", { ...deploy, allowed_environments: [] }],
    ["a repository that is not owner/name", { ...deploy, allowed_repositories: ["app"] }],
    ["a short workflow sha", { ...deploy, workflow_sha: "abc" }],
    ["a missing author", { ...deploy, author_actor: undefined }],
    ["an unknown key", { ...deploy, approval_id: "x" }],
  ])("rejects %s", (_name, block) => {
    expect(projectConfigSchema.safeParse({ ...base, deploy: block }).success).toBe(false);
  });
});
