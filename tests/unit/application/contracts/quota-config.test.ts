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

describe("project config quota block", () => {
  it("leaves quota selection off when the block is absent, so older configs stay valid", () => {
    expect(projectConfigSchema.parse(base).quota).toBeUndefined();
  });
  it("fills thresholds and keeps Coordinator-shared profiles penalised, not forbidden", () => {
    expect(projectConfigSchema.parse({ ...base, quota: {} }).quota).toEqual({
      min_five_hour_left_percent: 10,
      min_seven_day_left_percent: 10,
      coordinator_shared_penalty: 20,
      coordinator_shared_policy: "penalize",
      coordinator_shared_profiles: [],
      stale_after_minutes: 120,
      probe_when_stale: false,
    });
  });
  it("accepts explicit thresholds and a forbidden Coordinator-shared profile", () => {
    const quota = projectConfigSchema.parse({
      ...base,
      quota: {
        min_five_hour_left_percent: 25,
        coordinator_shared_policy: "forbid",
        coordinator_shared_profiles: ["claude-main"],
      },
    }).quota;
    expect(quota).toMatchObject({
      min_five_hour_left_percent: 25,
      coordinator_shared_policy: "forbid",
      coordinator_shared_profiles: ["claude-main"],
    });
  });
  it.each([
    { min_five_hour_left_percent: 101 },
    { min_seven_day_left_percent: -1 },
    { coordinator_shared_policy: "allow" },
    { stale_after_minutes: 0 },
    { unknown_key: true },
  ])("rejects invalid quota settings %j", (quota) => {
    expect(projectConfigSchema.safeParse({ ...base, quota }).success).toBe(false);
  });
});
