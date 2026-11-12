import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../../../../src/application/contracts/project-config.ts";
import { modelsConfigSchema } from "../../../../src/application/contracts/model-capability.ts";
import { workflowSchema } from "../../../../src/application/contracts/workflow.ts";
import { taskComplexitySchema } from "../../../../src/application/contracts/task-complexity.ts";
import type { ExecutorSelectionStore } from "../../../../src/application/ports/executor-selection-store.ts";
import type {
  QuotaReader,
  QuotaReadResult,
} from "../../../../src/application/ports/quota-reader.ts";
import {
  createDispatchPlanner,
  type DispatchTask,
} from "../../../../src/application/services/plan-step-dispatch.ts";
import { DispatchPlanningError } from "../../../../src/application/services/resolve-dispatch-task.ts";
import type { RegisteredProfile } from "../../../../src/domain/profiles/profile-metadata.ts";
import type { QuotaReading } from "../../../../src/domain/profiles/quota-policy.ts";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const hash = "a".repeat(64);
const baseConfig = {
  schema_version: 1,
  repository: { owner: "acme", name: "app" },
  project: { owner: "acme", number: 1 },
  branches: { integration: "develop", release: "main" },
  limits: { max_parallel_workers: 2, step_timeout_seconds: 60, max_rework_cycles: 2 },
  effort_policy: { low: "low", medium: "medium", high: "high" },
  policies: { mandatory_approvals: [] },
};
const models = modelsConfigSchema.parse({
  schema_version: 1,
  models: {
    opus: { executor: "claude-code", model: "opus", supported_efforts: ["medium", "high"] },
  },
  capability_profiles: { standard: { min_effort: "medium" } },
  verified_models: { standard: ["opus"] },
});
const workflow = workflowSchema.parse({
  schema_version: 1,
  id: "feature",
  version: 1,
  selection: { task_types: ["task"] },
  quality_policy: "bounded-rework",
  steps: [
    {
      id: "implement",
      role: "developer",
      needs: [],
      capability_profile: "standard",
      output_contract: "step-result",
    },
  ],
});
const profile = (
  id: string,
  over: Partial<RegisteredProfile["metadata"]> = {},
): RegisteredProfile => ({
  revision: 1,
  activeWorkers: 0,
  metadata: {
    profileId: id,
    tool: "claude-code",
    authMode: "subscription",
    credentialRef: `/profiles/${id}`,
    accountGroupId: id,
    modelAllowlist: ["opus"],
    state: "ready",
    lastProbeAt: NOW - 10,
    probeTtlMs: HOUR,
    maxConcurrency: 1,
    accountGroupMaxConcurrency: 1,
    preference: 0,
    ...over,
  },
});
const request = { runId: "run-1", stepRunId: "step-1", stepId: "implement", taskId: "task-142" };
const task: DispatchTask = {
  context: {
    taskSnapshot: { issueNumber: 142, title: "Runtime", body: "Untrusted task prose" },
    acceptanceCriteria: ["Works"],
    businessBaselineHash: hash,
    inputArtifacts: [],
    previousFindings: [],
    allowedScope: { paths: ["src"] },
    approvalRefs: [],
  },
  complexity: taskComplexitySchema.parse({ complexity: "high" }),
  workspace: { taskId: "omi-070", slug: "runtime-composition" },
};
const reading = (usedFive: number, over: Partial<QuotaReading> = {}): QuotaReading => ({
  source: "claude-usage-api",
  observedAt: NOW - 1000,
  fiveHour: { usedPercent: usedFive, resetsAt: NOW + HOUR },
  sevenDay: { usedPercent: 20, resetsAt: NOW + 48 * HOUR },
  status: "allowed",
  limited: false,
  resetCredits: null,
  modelWindows: [],
  ...over,
});

function setup(options: {
  profiles: readonly RegisteredProfile[];
  readings: Record<string, QuotaReading | null | "throw">;
  quota?: Record<string, unknown> | undefined;
  withReader?: boolean;
}) {
  const calls: { profileId: string; probe: boolean }[] = [];
  const reservations: string[] = [];
  const reader: QuotaReader = {
    read: (ref, readOptions): Promise<QuotaReadResult> => {
      calls.push({ profileId: ref.profileId, probe: readOptions.probe });
      const value = options.readings[ref.profileId];
      if (value === "throw") return Promise.reject(new Error("reader exploded"));
      return Promise.resolve({ reading: value ?? null, note: null });
    },
  };
  const selections: ExecutorSelectionStore = {
    reserve: (attempt, choose) => {
      const decision = choose(options.profiles);
      if (decision.outcome === "selected") reservations.push(attempt.id);
      return decision;
    },
    settings: () => undefined,
    listSettings: () => [],
    recordResult: () => undefined,
  };
  let id = 0;
  const planner = createDispatchPlanner({
    config: projectConfigSchema.parse({
      ...baseConfig,
      ...(options.quota === undefined ? {} : { quota: options.quota }),
    }),
    models,
    plans: {
      findTask: () => undefined,
      forRun: () => ({
        taskId: "task-142",
        projectId: "p",
        repository: "acme/app",
        issueNumber: 142,
        templateHash: hash,
      }),
      createRun: () => ({ ok: true as const }),
    },
    workflows: { byId: () => ({ workflow, hash }), byHash: () => ({ workflow, hash }) },
    profiles: { list: () => options.profiles, save: () => true },
    selections,
    task: () => Promise.resolve(task),
    nextAttemptNumber: () => 1,
    cancelReservation: () => undefined,
    now: () => NOW,
    nextId: () => `id-${String(++id)}`,
    ...(options.withReader === false ? {} : { quota: reader }),
  });
  return { planner, calls, reservations };
}

describe("dispatch planning with quota policy", () => {
  it("plans on the profile with the most quota left before reserving the attempt", async () => {
    const r = setup({
      profiles: [profile("tight"), profile("roomy")],
      readings: { tight: reading(80), roomy: reading(10) },
      quota: {},
    });
    const input = await r.planner.plan(request);
    expect(input).toMatchObject({ execution: { profileHome: "/profiles/roomy" } });
    expect(r.reservations).toEqual(["id-1"]);
  });

  it("skips a profile below the threshold and plans on the next one", async () => {
    const r = setup({
      profiles: [profile("empty", { preference: 0 }), profile("ok", { preference: 1 })],
      readings: { empty: reading(97), ok: reading(50) },
      quota: {},
    });
    expect(await r.planner.plan(request)).toMatchObject({
      execution: { profileHome: "/profiles/ok" },
    });
  });

  it("refuses with the earliest reset when every profile is below the threshold, reserving nothing", async () => {
    const soon = NOW + 30 * 60_000;
    const r = setup({
      profiles: [profile("a"), profile("b")],
      readings: {
        a: reading(95, { fiveHour: { usedPercent: 95, resetsAt: soon + HOUR } }),
        b: reading(95, { fiveHour: { usedPercent: 95, resetsAt: soon } }),
      },
      quota: {},
    });
    const error = await r.planner.plan(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DispatchPlanningError);
    expect(error).toMatchObject({
      reason: "QUOTA_EXHAUSTED",
      detail: `earliest_reset=${new Date(soon).toISOString()}`,
    });
    expect(r.reservations).toEqual([]);
  });

  it("does not call a quota shortage what is really a cooldown or other blocker", async () => {
    const r = setup({
      profiles: [profile("a", { state: "cooldown", cooldownUntil: NOW + HOUR })],
      readings: { a: reading(97) },
      quota: {},
    });
    expect(await r.planner.plan(request)).toBeUndefined();
  });

  it("never refuses for quota when the config has no quota block", async () => {
    const r = setup({
      profiles: [profile("a")],
      readings: { a: reading(99) },
    });
    expect(await r.planner.plan(request)).toMatchObject({
      execution: { profileHome: "/profiles/a" },
    });
    expect(r.calls).toEqual([]);
  });

  it("does not stop dispatch when no quota reader is wired", async () => {
    const r = setup({
      profiles: [profile("a")],
      readings: {},
      quota: {},
      withReader: false,
    });
    expect(await r.planner.plan(request)).toMatchObject({
      execution: { profileHome: "/profiles/a" },
    });
  });

  it("treats a reader that throws as no reading, never as a refusal", async () => {
    const r = setup({
      profiles: [profile("a")],
      readings: { a: "throw" },
      quota: {},
    });
    expect(await r.planner.plan(request)).toMatchObject({
      execution: { profileHome: "/profiles/a" },
    });
  });

  it("does not choose a profile marked as sharing the Coordinator account when config forbids it", async () => {
    const r = setup({
      profiles: [profile("coordinator", { preference: 0 }), profile("worker", { preference: 1 })],
      readings: { coordinator: reading(0), worker: reading(60) },
      quota: { coordinator_shared_policy: "forbid", coordinator_shared_profiles: ["coordinator"] },
    });
    expect(await r.planner.plan(request)).toMatchObject({
      execution: { profileHome: "/profiles/worker" },
    });
  });

  it("probes a profile whose reading is stale only when the config allows it", async () => {
    const stale = reading(10, { observedAt: NOW - 5 * HOUR });
    const off = setup({ profiles: [profile("a")], readings: { a: stale }, quota: {} });
    await off.planner.plan(request);
    expect(off.calls).toEqual([{ profileId: "a", probe: false }]);
    const on = setup({
      profiles: [profile("a")],
      readings: { a: stale },
      quota: { probe_when_stale: true },
    });
    await on.planner.plan(request);
    expect(on.calls).toEqual([
      { profileId: "a", probe: false },
      { profileId: "a", probe: true },
    ]);
  });
});
