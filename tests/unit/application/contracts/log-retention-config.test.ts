import { describe, expect, it } from "vitest";
import { logRetentionSettings } from "../../../../src/application/contracts/log-retention.ts";
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

describe("project config log_retention block", () => {
  it("is optional, so older configs stay valid", () => {
    expect(projectConfigSchema.parse(base).log_retention).toBeUndefined();
  });

  it("fills defaults for an empty block and accepts explicit limits", () => {
    expect(projectConfigSchema.parse({ ...base, log_retention: {} }).log_retention).toEqual({
      recent_minutes: 30,
      archive_max_bytes: 50 * 1024 * 1024,
      archive_max_age_days: 30,
    });
    expect(
      projectConfigSchema.parse({ ...base, log_retention: { archive_max_bytes: 1000 } })
        .log_retention?.archive_max_bytes,
    ).toBe(1000);
  });

  it("rejects an unknown key", () => {
    expect(
      projectConfigSchema.safeParse({ ...base, log_retention: { keep_forever: true } }).success,
    ).toBe(false);
  });

  it("turns config into the policy settings, with defaults when the block is absent", () => {
    expect(logRetentionSettings(undefined)).toEqual({
      recentMinutes: 30,
      archiveMaxBytes: 50 * 1024 * 1024,
      archiveMaxAgeDays: 30,
    });
    expect(
      logRetentionSettings({ recent_minutes: 5, archive_max_bytes: 9, archive_max_age_days: 2 }),
    ).toEqual({ recentMinutes: 5, archiveMaxBytes: 9, archiveMaxAgeDays: 2 });
  });
});
