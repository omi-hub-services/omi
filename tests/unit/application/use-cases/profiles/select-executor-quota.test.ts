import { describe, expect, it } from "vitest";
import type { ExecutorSelectionStore } from "../../../../../src/application/ports/executor-selection-store.ts";
import { selectExecutor } from "../../../../../src/application/use-cases/profiles/select-executor.ts";
import type { RegisteredProfile } from "../../../../../src/domain/profiles/profile-metadata.ts";
import type { QuotaVerdict } from "../../../../../src/domain/profiles/quota-policy.ts";

const profile: RegisteredProfile = {
  revision: 1,
  activeWorkers: 0,
  metadata: {
    profileId: "p",
    tool: "codex",
    authMode: "subscription",
    credentialRef: "/profiles/p",
    accountGroupId: "p",
    modelAllowlist: ["opaque-a"],
    state: "ready",
    lastProbeAt: 100,
    probeTtlMs: 1000,
    maxConcurrency: 2,
    accountGroupMaxConcurrency: 2,
    preference: 0,
  },
};
const store: ExecutorSelectionStore = {
  reserve: (_attempt, choose) => choose([profile]),
  settings: () => undefined,
  listSettings: () => [],
  recordResult: () => undefined,
};
const request = {
  attemptId: "a",
  stepRunId: "s",
  attemptNumber: 1,
  capabilityProfile: "coding",
  now: 100,
  models: {
    schema_version: 1,
    models: { capable: { executor: "codex", model: "opaque-a", supported_efforts: ["high"] } },
    capability_profiles: { coding: { min_effort: "low" } },
    verified_models: { coding: ["capable"] },
  },
  task: { workflow: "feature", workType: "Task", area: "runtime", priority: "P1", acCount: 4 },
};
const blocked: QuotaVerdict = {
  profileId: "p",
  freshness: "fresh",
  fiveHourLeft: 2,
  sevenDayLeft: 50,
  fiveHourResetsAt: null,
  score: 2,
  blocked: ["FIVE_HOUR_BELOW_THRESHOLD"],
  blockedUntil: 5000,
  resetCredits: null,
  modelWindows: [],
};

describe("selectExecutor with quota verdicts", () => {
  it("selects the profile when no verdicts are supplied", () => {
    expect(selectExecutor(store, request).outcome).toBe("selected");
  });
  it("makes a profile below its quota threshold wait instead of being chosen", () => {
    const result = selectExecutor(store, { ...request, quota: new Map([["p", blocked]]) });
    expect(result).toMatchObject({
      outcome: "waiting_resource",
      reason: "NO_MATCHING_COMBINATION",
    });
    if (result.outcome !== "waiting_resource") throw new Error("unexpected selection");
    expect(result.rejections).toEqual([
      { candidateId: "p:capable", reasons: ["QUOTA_BELOW_THRESHOLD"] },
    ]);
  });
});
