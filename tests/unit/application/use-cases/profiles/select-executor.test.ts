import { describe, expect, it } from "vitest";
import type { ExecutorSelectionStore } from "../../../../../src/application/ports/executor-selection-store.ts";
import { selectExecutor } from "../../../../../src/application/use-cases/profiles/select-executor.ts";
import type { SelectionResult } from "../../../../../src/domain/agents/selection-policy.ts";
import type { RegisteredProfile } from "../../../../../src/domain/profiles/profile-metadata.ts";

const profile: RegisteredProfile = {
  revision: 1,
  activeWorkers: 0,
  metadata: {
    profileId: "p",
    tool: "codex",
    authMode: "subscription",
    credentialRef: "/profiles/p",
    accountGroupId: "p",
    modelAllowlist: ["opaque-a", "opaque-b"],
    state: "ready",
    lastProbeAt: 100,
    probeTtlMs: 1000,
    maxConcurrency: 2,
    accountGroupMaxConcurrency: 2,
    preference: 0,
  },
};
function rig(profiles: readonly RegisteredProfile[] = [profile]) {
  const saved: { reason?: string; result?: SelectionResult } = {};
  const store: ExecutorSelectionStore = {
    reserve(attempt, choose) {
      if (attempt.selectionReason !== undefined) saved.reason = attempt.selectionReason;
      saved.result = choose(profiles);
      return saved.result;
    },
    settings: () => undefined,
    listSettings: () => [],
    recordResult: () => {
      throw new Error("not used");
    },
  };
  return { store, saved };
}
const models = {
  schema_version: 1,
  models: {
    cheap: { executor: "codex", model: "opaque-a", supported_efforts: ["low", "medium"] },
    capable: { executor: "codex", model: "opaque-b", supported_efforts: ["high", "xhigh"] },
  },
  capability_profiles: { coding: { min_effort: "low" } },
  verified_models: { coding: ["cheap", "capable"] },
};
const task = { workflow: "feature", workType: "Task", area: "runtime", priority: "P1", acCount: 4 };
const request = {
  attemptId: "a",
  stepRunId: "s",
  attemptNumber: 1,
  capabilityProfile: "coding",
  now: 100,
  models,
  task,
};

describe("task-aware executor selection", () => {
  it.each([
    ["docs", "low", "opaque-a"],
    ["bugfix", "medium", "opaque-a"],
    ["feature", "medium", "opaque-a"],
    ["poc", "high", "opaque-b"],
    ["security", "high", "opaque-b"],
  ])("selects %s model/effort from declarations", (workflow, effort, model) => {
    const r = rig();
    const result = selectExecutor(r.store, { ...request, task: { ...task, workflow } });
    expect(result).toMatchObject({ outcome: "selected", effort, candidate: { model } });
    expect(r.saved.reason).toContain(`minimum ${effort}`);
  });
  it("uses a configured mapping with manual override and the next supported effort", () => {
    const r = rig();
    const result = selectExecutor(r.store, {
      ...request,
      task: { ...task, workflow: "docs", complexity: "high" },
      effortPolicy: { low: "low", medium: "medium", high: "xhigh" },
    });
    expect(result).toMatchObject({
      outcome: "selected",
      effort: "xhigh",
      candidate: { model: "opaque-b" },
    });
    expect(r.saved.reason).toContain("field complexity:high");
  });
  it("returns typed reasons instead of selecting a lower effort when capable models are not allowlisted", () => {
    const r = rig([
      { ...profile, metadata: { ...profile.metadata, modelAllowlist: ["opaque-a"] } },
    ]);
    const result = selectExecutor(r.store, { ...request, task: { ...task, workflow: "poc" } });
    expect(result).toMatchObject({
      outcome: "waiting_resource",
      reason: "NO_MATCHING_COMBINATION",
      rejections: [
        { candidateId: "p:cheap", reasons: ["EFFORT_BELOW_MINIMUM"] },
        { candidateId: "p:capable", reasons: ["MODEL_NOT_ALLOWLISTED"] },
      ],
    });
  });
  it("never drops the capability floor for a manual low task", () => {
    expect(
      selectExecutor(rig().store, {
        ...request,
        task: { ...task, complexity: "low" },
        models: {
          ...models,
          capability_profiles: { coding: { min_effort: "high" } },
          verified_models: { coding: ["capable"] },
        },
      }),
    ).toMatchObject({ outcome: "selected", effort: "high", candidate: { model: "opaque-b" } });
  });
  it("does not downgrade when no model supports the configured floor", () => {
    expect(
      selectExecutor(rig().store, {
        ...request,
        effortPolicy: { low: "low", medium: "max", high: "max" },
      }),
    ).toMatchObject({ outcome: "waiting_resource", reason: "NO_MATCHING_COMBINATION" });
  });
  it("waits when a capable profile is cooling down instead of lowering the effort", () => {
    const r = rig([
      { ...profile, metadata: { ...profile.metadata, state: "cooldown", cooldownUntil: 200 } },
    ]);
    const result = selectExecutor(r.store, { ...request, task: { ...task, workflow: "poc" } });
    expect(result).toMatchObject({
      outcome: "waiting_resource",
      reason: "NO_MATCHING_COMBINATION",
    });
    if (result.outcome !== "waiting_resource") throw new Error("unexpected selection");
    expect(
      result.rejections.every(({ reasons }) => reasons.includes("ACCOUNT_GROUP_IN_COOLDOWN")),
    ).toBe(true);
  });
});
