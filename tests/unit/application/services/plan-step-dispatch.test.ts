import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../../../../src/application/contracts/project-config.ts";
import { modelsConfigSchema } from "../../../../src/application/contracts/model-capability.ts";
import { workflowSchema } from "../../../../src/application/contracts/workflow.ts";
import { taskComplexitySchema } from "../../../../src/application/contracts/task-complexity.ts";
import {
  createDispatchPlanner,
  type DispatchTask,
} from "../../../../src/application/services/plan-step-dispatch.ts";
import type { ExecutorSelectionStore } from "../../../../src/application/ports/executor-selection-store.ts";
import type { RegisteredProfile } from "../../../../src/domain/profiles/profile-metadata.ts";
import { dispatchStep } from "../../../../src/application/use-cases/runs/dispatch-step.ts";
import { rig } from "../use-cases/runs/run-fakes.ts";

const hash = "a".repeat(64);
const config = projectConfigSchema.parse({
  schema_version: 1,
  repository: { owner: "acme", name: "app" },
  project: { owner: "acme", number: 1 },
  branches: { integration: "develop", release: "main" },
  limits: { max_parallel_workers: 2, step_timeout_seconds: 60, max_rework_cycles: 2 },
  effort_policy: { low: "low", medium: "medium", high: "high" },
  policies: { mandatory_approvals: [] },
});
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
const profile: RegisteredProfile = {
  revision: 1,
  activeWorkers: 0,
  metadata: {
    profileId: "p",
    tool: "claude-code",
    authMode: "subscription",
    credentialRef: "/profiles/p",
    accountGroupId: "account",
    modelAllowlist: ["opus"],
    state: "ready",
    lastProbeAt: 100,
    probeTtlMs: 1000,
    maxConcurrency: 1,
    accountGroupMaxConcurrency: 1,
    preference: 0,
  },
};
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

function setup(
  profiles: readonly RegisteredProfile[] = [profile],
  readTask = () => Promise.resolve(task),
  registryProfiles = profiles,
  overrides: {
    config?: typeof config;
    workflow?: typeof workflow;
    findings?: { recall: (stepRunId: string) => never[] };
  } = {},
) {
  const reservations: string[] = [];
  let attemptNumber = 1;
  const cancelled: string[] = [];
  const selections: ExecutorSelectionStore = {
    reserve: (attempt, choose) => {
      const decision = choose(profiles);
      if (decision.outcome === "selected") {
        reservations.push(attempt.id);
        attemptNumber += 1;
      }
      return decision;
    },
    settings: () => undefined,
    listSettings: () => [],
    recordResult: () => undefined,
  };
  let id = 0;
  const plans = {
    findTask: () => undefined,
    forRun: () => ({
      taskId: "task-142",
      projectId: "p",
      repository: "acme/app",
      issueNumber: 142,
      templateHash: hash,
    }),
    createRun: () => ({ ok: true as const }),
  };
  const planner = createDispatchPlanner({
    config: overrides.config ?? config,
    models,
    plans,
    workflows: {
      byId: () => ({ workflow: overrides.workflow ?? workflow, hash }),
      byHash: () => ({ workflow: overrides.workflow ?? workflow, hash }),
    },
    profiles: { list: () => registryProfiles, save: () => true },
    selections,
    task: readTask,
    ...(overrides.findings === undefined ? {} : { findings: overrides.findings }),
    nextAttemptNumber: () => attemptNumber,
    cancelReservation: (attemptId) => cancelled.push(attemptId),
    now: () => 100,
    nextId: () => `id-${String(++id)}`,
  });
  return { planner, reservations, cancelled };
}

describe("dispatch planning from a trusted task boundary", () => {
  it("cancels the reserved capacity slot if the chosen profile disappears before plan construction", async () => {
    const r = setup([profile], () => Promise.resolve(task), []);
    await expect(r.planner.plan(request)).rejects.toThrow("PROFILE_UNKNOWN");
    expect(r.reservations).toEqual(["id-1"]);
    expect(r.cancelled).toEqual(["id-1"]);
  });
  it("uses the selector and complexity policy, then dispatch assembles the pinned role/context packet", async () => {
    const { planner, reservations } = setup();
    const input = await planner.plan(request);
    expect(input).toMatchObject({
      quality: { round: 1 },
      reservedAttemptId: "id-1",
      taskId: "omi-070",
      slug: "runtime-composition",
      execution: { profileHome: "/profiles/p", model: "opus", effort: "high" },
    });
    expect(reservations).toEqual(["id-1"]);
    const r = rig();
    const result = await dispatchStep(r.deps, { ...input, stepRunId: request.stepRunId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.contextPacket).toMatchObject({
      attemptId: "id-1",
      role: "developer",
      taskSnapshot: task.context.taskSnapshot,
      allowedScope: task.context.allowedScope,
      skillsManifest: [{ id: "tdd" }],
    });
    expect(result.attempt.selection?.reason).toContain("field complexity:high");
  });
  it("leaves no reservation when no eligible resource meets the effort floor", async () => {
    const { planner, reservations } = setup([
      { ...profile, metadata: { ...profile.metadata, state: "cooldown", cooldownUntil: 200 } },
    ]);
    expect(await planner.plan(request)).toBeUndefined();
    expect(reservations).toEqual([]);
  });
  it("does not reserve a slot for an unknown step or invalid trusted task", async () => {
    const r = setup();
    expect(await r.planner.plan({ ...request, stepId: "unknown" })).toBeUndefined();
    const invalid = setup([profile], () =>
      Promise.resolve({ ...task, context: { ...task.context, allowedScope: { paths: [] } } }),
    );
    await expect(invalid.planner.plan(request)).rejects.toThrow();
    expect(invalid.reservations).toEqual([]);
  });
  it("reads the authorized task once so selection and packet inputs share the same baseline", async () => {
    let reads = 0;
    const r = setup([profile], () => {
      reads += 1;
      return Promise.resolve(task);
    });
    await r.planner.plan(request);
    expect(reads).toBe(1);
  });
});

it("gives the next attempt the findings remembered for its step run", async () => {
  const finding = {
    id: "check-project-check",
    severity: "major" as const,
    message: "Check project-check failed (exit code 1).",
  };
  const asked: string[] = [];
  const { planner } = setup([profile], () => Promise.resolve(task), [profile], {
    findings: {
      recall: (stepRunId) => {
        asked.push(stepRunId);
        return [finding] as never[];
      },
    },
  });
  const input = await planner.plan(request);
  expect(asked).toEqual(["step-1"]);
  expect((input as { context: { previousFindings: unknown[] } }).context.previousFindings).toEqual([
    finding,
  ]);
});

describe("required checks of a workflow step", () => {
  const verifyWorkflow = workflowSchema.parse({
    ...workflow,
    steps: [{ ...workflow.steps[0], required_checks: ["project-check"] }],
  });
  const configured = projectConfigSchema.parse({
    ...config,
    checks: { "project-check": { command: ["npm", "run", "check"] } },
  });

  it("passes the step's required checks into the dispatch request", async () => {
    const r = setup([profile], () => Promise.resolve(task), [profile], {
      config: configured,
      workflow: verifyWorkflow,
    });
    expect(await r.planner.plan(request)).toMatchObject({ requiredChecks: ["project-check"] });
  });

  it("adds none for a step that lists none", async () => {
    const r = setup();
    expect(await r.planner.plan(request)).toMatchObject({ requiredChecks: [] });
  });

  it("refuses to dispatch a step whose check has no configured command, and frees the slot", async () => {
    const r = setup([profile], () => Promise.resolve(task), [profile], {
      workflow: verifyWorkflow,
    });
    await expect(r.planner.plan(request)).rejects.toThrow("CHECK_UNCONFIGURED");
    expect(r.cancelled).toEqual(["id-1"]);
  });
});

it("uses first review effort rather than the developer's high complexity effort", async () => {
  const reviewWorkflow = workflowSchema.parse({
    ...workflow,
    quality_policy: "strict",
    steps: [{ ...workflow.steps[0], id: "review", role: "reviewer" }],
  });
  const r = setup([profile], () => Promise.resolve(task), [profile], { workflow: reviewWorkflow });
  expect(await r.planner.plan({ ...request, stepId: "review" })).toMatchObject({
    execution: { effort: "medium" },
  });
});

it("forwards preceding QA evidence steps for a separate high-complexity review", async () => {
  const separate = workflowSchema.parse({
    ...workflow,
    quality_policy: "strict",
    steps: [
      { ...workflow.steps[0], id: "verify", role: "qa", required_checks: ["project-check"] },
      { ...workflow.steps[0], id: "review", role: "reviewer", needs: ["verify"] },
    ],
  });
  const r = setup([profile], () => Promise.resolve(task), [profile], { workflow: separate });
  expect(await r.planner.plan({ ...request, stepId: "review" })).toMatchObject({
    checkEvidenceSteps: ["verify"],
    requiredChecks: [],
  });
});
