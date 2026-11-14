import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../../../../src/domain/approvals/approval.ts";
import type { ReworkState } from "../../../../../src/domain/runs/rework-policy.ts";
import { INITIAL_REWORK_STATE } from "../../../../../src/domain/runs/rework-policy.ts";
import type { RunStatus } from "../../../../../src/domain/runs/workflow-run.ts";
import { rig, dispatchInput } from "./run-fakes.ts";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import type { DispatchRunStepDependencies } from "../../../../../src/application/use-cases/runs/dispatch-run-step.ts";
import { recoveryRig } from "./recovery-fakes.ts";
import { workflowSchema } from "../../../../../src/application/contracts/workflow.ts";
import { modelsConfigSchema } from "../../../../../src/application/contracts/model-capability.ts";
import { parseProfileMetadata } from "../../../../../src/application/contracts/profile-metadata.ts";
import {
  effortPolicySchema,
  taskComplexitySchema,
} from "../../../../../src/application/contracts/task-complexity.ts";
import type { FailoverStepDependencies } from "../../../../../src/application/use-cases/profiles/failover-step.ts";
import { retryStep } from "../../../../../src/application/use-cases/runs/retry-step.ts";
import {
  DispatchPlanningError,
  type DispatchPlanningRefusal,
} from "../../../../../src/application/services/dispatch-planning-error.ts";
import { createCommandDispatcher } from "../../../../../src/interfaces/ipc/command-dispatcher.ts";
import { runCli } from "../../../../../src/interfaces/cli/commands/create-program.ts";
import { inspectRuntime } from "../../../../../src/application/use-cases/project/inspect-runtime.ts";

async function setup(status: "failed" | "ready" | "waiting_resource" | "succeeded" = "ready") {
  const r = rig(status);
  const seed = await dispatchStep(rig().deps, dispatchInput());
  if (!seed.ok) throw new Error(seed.reason);
  r.attempts.rows.set(seed.attempt.id, { ...seed.attempt, status: "failed" });
  const state: { status: RunStatus; rework: ReworkState; failures: number; version: number } = {
    status: "running",
    rework: { ...INITIAL_REWORK_STATE, failedCycles: 1, countedCycleIds: [seed.attempt.id] },
    failures: 0,
    version: 0,
  };
  const completions: Promise<void>[] = [];
  const dispatch: DispatchRunStepDependencies = {
    ...r.deps,
    runs: {
      get: () => ({ id: "run-1", status: state.status, version: state.version }),
      listSteps: () => [...r.steps.rows.values()],
    },
    plans: { forRun: () => undefined },
    workflows: { byId: () => undefined, byHash: () => undefined },
    planner: { plan: () => Promise.resolve(dispatchInput()) },
    session: { commit: (change) => r.unitOfWork.commit({ ...change, at: "t" }) },
    track: (p) => completions.push(p),
  };
  const deps = {
    dispatch,
    rework: {
      runs: {
        get: () => ({
          id: "run-1",
          taskId: "task",
          status: state.status,
          version: state.version,
          rework: state.rework,
        }),
      },
      session: {
        ...dispatch.session,
        lease: {
          resourceKey: "project-owner",
          owner: "o",
          generation: 1,
          acquiredAt: "t",
          expiresAt: "t",
        },
        renew: () => true,
        record: () => {},
        release: () => {},
      },
      checkpoint: () => ({ ok: false as const }),
      nextId: r.deps.nextId,
    },
    operationalFailures: () => state.failures,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60000 },
  };
  deps.rework.session.commit = (change) => {
    if (change.target.kind === "workflow_run") {
      state.status = change.target.toStatus;
      if (change.target.rework !== undefined) state.rework = change.target.rework;
      state.version += 1;
      return { ok: true, newVersion: state.version, eventSequence: 1 };
    }
    return dispatch.session.commit(change);
  };
  return { r, state, deps, completions };
}
const input = { runId: "run-1", stepId: "implement" };

describe("retryStep", () => {
  it("does not start a worker if rework escalates during asynchronous dispatch planning", async () => {
    const { deps, state, r, completions } = await setup();
    deps.dispatch.planner.plan = () => {
      state.rework = { ...state.rework, phase: "architect", failedCycles: 2 };
      return Promise.resolve(dispatchInput());
    };
    expect(await retryStep(deps, input)).toMatchObject({ ok: false, reason: "RUN_NOT_RUNNING" });
    expect(r.executor.started).toHaveLength(0);
    await Promise.all(completions);
  });
  it("redispatches an automatically readied step as a new attempt without changing quality history", async () => {
    const { r, state, deps, completions } = await setup();
    const before = structuredClone(state.rework);
    const previous = r.attempts.latestForStep("step-1");
    const result = await retryStep(deps, input);
    expect(result).toMatchObject({ ok: true });
    expect(r.executor.started).toHaveLength(1);
    expect(r.attempts.latestForStep("step-1")?.attemptNumber).toBe(
      (previous?.attemptNumber ?? 0) + 1,
    );
    expect(state.rework).toEqual(before);
    await Promise.all(completions);
  });
  it("authorizes a failed step after an Architect intervention without resetting the assisted count", async () => {
    const { state, deps, completions, r } = await setup("failed");
    state.rework = {
      ...state.rework,
      phase: "assisted",
      failedCycles: 1,
      architectInterventionId: "arch",
    };
    const before = structuredClone(state.rework);
    expect(await retryStep(deps, input)).toMatchObject({ ok: true });
    expect(r.unitOfWork.commits[0]?.event.kind).toBe("step.retry_authorized");
    expect(state.rework).toEqual(before);
    await Promise.all(completions);
  });
  it.each(["paused", "interrupted", "succeeded", "cancelled"] as const)(
    "refuses a %s run",
    async (status) => {
      const { deps, state, r } = await setup();
      state.status = status;
      expect(await retryStep(deps, input)).toEqual({ ok: false, reason: "RUN_NOT_RUNNING" });
      expect(r.executor.started).toHaveLength(0);
    },
  );
  it("refuses blocked without a PO decision", async () => {
    const { deps, state } = await setup("failed");
    state.status = "blocked";
    state.rework = { ...state.rework, phase: "blocked" };
    expect(await retryStep(deps, input)).toEqual({ ok: false, reason: "PO_DECISION_REQUIRED" });
  });
  it("refuses architect_required even with a supplied decision", async () => {
    const { deps, state } = await setup("failed");
    state.rework = { ...state.rework, phase: "architect", failedCycles: 2 };
    expect(await retryStep(deps, { ...input, poDecisionId: "decision" })).toEqual({
      ok: false,
      reason: "ARCHITECT_REQUIRED",
    });
  });
  it("refuses a successful step", async () => {
    const { deps } = await setup("succeeded");
    expect(await retryStep(deps, input)).toEqual({ ok: false, reason: "STEP_NOT_FAILED" });
  });
  it("refuses an initial ready step that has never failed", async () => {
    const { deps, r } = await setup();
    r.attempts.rows.clear();
    expect(await retryStep(deps, input)).toEqual({ ok: false, reason: "STEP_NOT_FAILED" });
  });
  it("refuses spent infrastructure budget before any step mutation", async () => {
    const { deps, state, r } = await setup("failed");
    state.failures = 4;
    state.rework = INITIAL_REWORK_STATE;
    expect(await retryStep(deps, input)).toEqual({ ok: false, reason: "RETRY_BUDGET_EXHAUSTED" });
    expect(r.unitOfWork.commits).toHaveLength(0);
  });
  it("does not charge quality retries against infrastructure budget", async () => {
    const { deps, state, completions } = await setup();
    state.failures = 4;
    expect(await retryStep(deps, input)).toMatchObject({ ok: true });
    await Promise.all(completions);
  });
});

async function failoverSetup() {
  const { r, state, deps } = await setup("waiting_resource");
  const recovery = recoveryRig();
  const workflow = workflowSchema.parse({
    schema_version: 1,
    id: "feature",
    version: 1,
    selection: { task_types: ["feature"] },
    quality_policy: "strict",
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
  deps.dispatch.plans.forRun = () => ({
    projectId: "p",
    taskId: "task",
    repository: "acme/app",
    issueNumber: 1,
    templateHash: "h",
  });
  deps.dispatch.workflows.byHash = () => ({ hash: "h", workflow });
  deps.dispatch.planner.plan = () => {
    return Promise.reject(new Error("must reenter failover"));
  };
  const metadata = parseProfileMetadata({
    profileId: "alternate",
    tool: "claude-code",
    authMode: "subscription",
    credentialRef: "/profiles/alternate",
    accountGroupId: "alternate",
    modelAllowlist: ["opus"],
    state: "ready",
    lastProbeAt: r.deps.now(),
    probeTtlMs: 60000,
    maxConcurrency: 1,
    accountGroupMaxConcurrency: 1,
    preference: 0,
  });
  const profiles = [{ metadata, revision: 1, observedAt: r.deps.now(), activeWorkers: 0 }];
  const failover: FailoverStepDependencies = {
    ...recovery.deps,
    session: deps.rework.session,
    runs: deps.dispatch.runs,
    attempts: r.attempts,
    workspaces: r.workspaces,
    artifacts: r.artifacts,
    profiles: { list: () => profiles, save: () => true },
    selections: {
      reserve: (_attempt, choose) => choose(profiles),
      recordResult: () => {},
      listSettings: () => [],
      settings: () => undefined,
    },
    retryBudget: deps.retryBudget,
    jitter: () => 0,
    dispatch: async ({ selection }) => {
      const dispatched = await dispatchStep(
        r.deps,
        dispatchInput({ reservedAttemptId: selection.attemptId }),
      );
      return dispatched.ok ? { ok: true, attemptId: dispatched.attempt.id } : dispatched;
    },
  };
  const retryDeps = {
    ...deps,
    failover: {
      dependencies: failover,
      models: modelsConfigSchema.parse(dispatchInput()["models"]),
      effortPolicy: effortPolicySchema.parse(undefined),
      readTask: () =>
        Promise.resolve({
          complexity: taskComplexitySchema.parse(undefined),
          workspace: { taskId: "omi-116", slug: "retry" },
          context: {
            taskSnapshot: { issueNumber: 1, title: "Retry", body: "Retry" },
            acceptanceCriteria: ["works"],
            businessBaselineHash: "a".repeat(64),
            inputArtifacts: [],
            previousFindings: [],
            allowedScope: { paths: ["src"] },
            approvalRefs: [],
          },
        }),
    },
  };
  return { r, state, deps: retryDeps, recovery };
}

it("reenters failover, reconciles the checkpoint and selects a new attempt without resetting quality", async () => {
  const { r, state, deps, recovery } = await failoverSetup();
  const before = structuredClone(state.rework);
  const result = await retryStep(deps, input);
  expect(result).toMatchObject({ ok: true, outcome: "failed_over", profileId: "alternate" });
  expect(recovery.state.order).toContain("checkpoint");
  expect(recovery.state.order).toContain("gates");
  expect(r.executor.started).toHaveLength(1);
  expect(r.attempts.latestForStep("step-1")?.attemptNumber).toBe(2);
  expect(state.rework).toEqual(before);
});

it.each([
  ["BUSINESS_APPROVAL_STALE", undefined],
  ["BUSINESS_APPROVAL_REQUIRED", undefined],
  ["IMPLEMENTATION_MAP_EMPTY", undefined],
  ["PLAN_KEY_REQUIRED", undefined],
  ["TASK_NOT_FOUND", undefined],
  ["QUOTA_EXHAUSTED", "earliest_reset=unknown"],
  ["TEMPLATE_UNAVAILABLE", "template_hash=h"],
] satisfies [DispatchPlanningRefusal, string | undefined][])(
  "returns %s from failover task planning without side effects",
  async (reason, detail) => {
    const { r, state, deps, recovery } = await failoverSetup();
    const before = structuredClone({ state, steps: r.steps.rows, attempts: r.attempts.rows });
    deps.failover.readTask = () => Promise.reject(new DispatchPlanningError(reason, detail));
    await expect(retryStep(deps, input)).resolves.toEqual({
      ok: false,
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
    expect({ state, steps: r.steps.rows, attempts: r.attempts.rows }).toEqual(before);
    expect(r.unitOfWork.commits).toHaveLength(0);
    expect(r.executor.started).toHaveLength(0);
    expect(r.workspaces.leases.size).toBe(0);
    expect(r.artifacts.files.size).toBe(0);
    expect(recovery.state.order).toEqual([]);
  },
);

it("propagates unexpected failover task reader errors", async () => {
  const { deps } = await failoverSetup();
  const error = new Error("unexpected task reader failure");
  deps.failover.readTask = () => Promise.reject(error);
  await expect(retryStep(deps, input)).rejects.toBe(error);
});

it("presents stale business approval on retry as COMMAND_REFUSED through IPC and CLI", async () => {
  const { deps } = await failoverSetup();
  deps.failover.readTask = () =>
    Promise.reject(new DispatchPlanningError("BUSINESS_APPROVAL_STALE"));
  const handler = createCommandDispatcher({
    retryStep: (request) => retryStep(deps, request),
    inspectRuntime: () =>
      inspectRuntime({ runtimeVersion: "0", startedAt: "2026-11-11T00:00:00.000Z" }),
  });
  let output = "";
  const code = await runCli(["--json", "retry", "--run", "run-1", "--step", "implement"], {
    sendCommand: ({ command }) => handler(command),
    defaultSocketPath: "/unused",
    timeoutMs: 100,
    version: "0",
    stdout: (text) => {
      output += text;
    },
    stderr: () => undefined,
  });
  expect(code).toBe(4);
  expect(JSON.parse(output)).toMatchObject({
    error: { code: "COMMAND_REFUSED", message: "BUSINESS_APPROVAL_STALE" },
  });
});

async function blockedSetup() {
  const r = await setup("failed");
  r.state.status = "blocked";
  r.state.rework = { ...r.state.rework, phase: "blocked", failedCycles: 2 };
  const subject = { kind: "business" as const, baselineHash: "a".repeat(64), scopeIds: ["task"] };
  const approved: ApprovalRequest = {
    id: "decision",
    runId: "run-1",
    subjectId: "task",
    subject,
    subjectHash: subject.baselineHash,
    status: "approved",
    version: 1,
    requestedAt: 1,
    decision: {
      id: "decision",
      subject,
      decision: "approved",
      actor: "po",
      source: "github-actor",
      evidenceRef: "comment:123",
      decidedAt: 2,
    },
  };
  const approvalState = { request: approved as ApprovalRequest | undefined, subject };
  const deps = {
    ...r.deps,
    rework: {
      ...r.deps.rework,
      approvals: {
        store: { get: () => approvalState.request },
        subjects: { read: () => approvalState.subject },
        now: r.r.deps.now,
        allowedGitHubActors: ["po"],
        authorActor: () => Promise.resolve("developer"),
      },
    },
  };
  return { ...r, deps, approvalState };
}

it.each(["unknown", "rejected", "stale"])(
  "retry refuses an %s approval without reopening or dispatching",
  async (kind) => {
    const { deps, state, r, approvalState } = await blockedSetup();
    if (kind === "unknown") approvalState.request = undefined;
    else if (kind === "stale")
      approvalState.subject = { ...approvalState.subject, baselineHash: "b".repeat(64) };
    else if (approvalState.request !== undefined)
      approvalState.request = { ...approvalState.request, status: "rejected" };
    expect(await retryStep(deps, { ...input, poDecisionId: "decision" })).toEqual({
      ok: false,
      reason:
        kind === "unknown"
          ? "NO_APPROVAL"
          : kind === "stale"
            ? "STALE_REVISION"
            : "APPROVAL_NOT_ACTIVE",
    });
    expect(state.status).toBe("blocked");
    expect(r.executor.started).toHaveLength(0);
  },
);

it("reopens with an approved decision and dispatches while retaining the history", async () => {
  const { deps, state, r, completions } = await blockedSetup();
  const history = [...state.rework.countedCycleIds];
  expect(await retryStep(deps, { ...input, poDecisionId: "decision" })).toMatchObject({ ok: true });
  expect(state.status).toBe("running");
  expect(state.rework.countedCycleIds).toEqual(history);
  expect(state.rework.reopenDecisionIds).toEqual(["decision"]);
  expect(r.executor.started).toHaveLength(1);
  await Promise.all(completions);
});
