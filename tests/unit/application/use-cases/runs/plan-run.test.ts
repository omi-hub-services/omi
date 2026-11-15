import { describe, expect, it } from "vitest";
import { workflowSchema } from "../../../../../src/application/contracts/workflow.ts";
import type { RunPlan, RunPlanStore } from "../../../../../src/application/ports/run-plan-store.ts";
import type { WorkflowCatalog } from "../../../../../src/application/ports/workflow-catalog.ts";
import { planRun } from "../../../../../src/application/use-cases/runs/plan-run.ts";

const step = (id: string, needs: string[]) => ({
  id,
  role: "developer",
  needs,
  skills: [],
  rules: [],
  capability_profile: "standard",
  output_contract: "step-result",
});
const workflow = (steps: ReturnType<typeof step>[]) =>
  workflowSchema.parse({
    schema_version: 1,
    id: "demo",
    version: 1,
    selection: { task_types: ["feature"] },
    quality_policy: "task-default",
    steps,
  });

function setup(steps = [step("a", []), step("b", ["a"]), step("c", ["a", "b"]), step("d", [])]) {
  const created: RunPlan[] = [];
  let active = false;
  const tasks: RunPlanStore = {
    findTask: (issueNumber) =>
      issueNumber === 35
        ? { taskId: "task-35", projectId: "p", repository: "acme/app", issueNumber }
        : undefined,
    forRun: () => undefined,
    createRun(plan) {
      if (active) return { ok: false, reason: "ACTIVE_RUN_EXISTS" };
      active = true;
      created.push(plan);
      return { ok: true };
    },
  };
  const pinned = { workflow: workflow(steps), hash: "f".repeat(64) };
  const workflows: WorkflowCatalog = {
    byId: (id) => (id === "demo" ? pinned : undefined),
    byHash: () => pinned,
  };
  let n = 0;
  const deps = {
    tasks,
    workflows,
    now: () => Date.parse("2026-11-11T00:00:00.000Z"),
    nextId: () => `id-${String(++n)}`,
  };
  return { deps, created };
}

describe("planRun", () => {
  it("readies only steps without dependencies and pins the template hash", () => {
    const { deps, created } = setup();
    const result = planRun(deps, { issueNumber: 35, workflowId: "demo" });
    expect(result).toMatchObject({
      ok: true,
      taskId: "task-35",
      workflowId: "demo",
      steps: [
        { stepId: "a", status: "ready" },
        { stepId: "b", status: "pending" },
        { stepId: "c", status: "pending" },
        { stepId: "d", status: "ready" },
      ],
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ templateHash: "f".repeat(64), taskId: "task-35" });
    expect(new Set(created[0]?.steps.map((entry) => entry.stepRunId)).size).toBe(4);
  });

  it("uses the configured default only when the command names no workflow", () => {
    const { deps } = setup();
    expect(planRun(deps, { issueNumber: 35 })).toEqual({ ok: false, reason: "WORKFLOW_REQUIRED" });
    expect(planRun({ ...deps, defaultWorkflowId: "demo" }, { issueNumber: 35 })).toMatchObject({
      ok: true,
      workflowId: "demo",
    });
  });

  it.each([
    [{ issueNumber: 35, workflowId: "missing" }, "WORKFLOW_UNKNOWN"],
    [{ issueNumber: 1, workflowId: "demo" }, "TASK_NOT_FOUND"],
    [{ issueNumber: 0, workflowId: "demo" }, "INVALID_INPUT"],
    [{ issueNumber: 35, workflowId: "demo", extra: 1 }, "INVALID_INPUT"],
  ])("refuses %j with %s and creates nothing", (input, reason) => {
    const { deps, created } = setup();
    expect(planRun(deps, input)).toEqual({ ok: false, reason });
    expect(created).toEqual([]);
  });

  it("refuses a cyclic template", () => {
    const { deps, created } = setup([step("a", ["b"]), step("b", ["a"])]);
    expect(planRun(deps, { issueNumber: 35, workflowId: "demo" })).toEqual({
      ok: false,
      reason: "WORKFLOW_CYCLIC",
    });
    expect(created).toEqual([]);
  });

  it("passes a second active run for the task through as a refusal", () => {
    const { deps } = setup();
    expect(planRun(deps, { issueNumber: 35, workflowId: "demo" })).toMatchObject({ ok: true });
    expect(planRun(deps, { issueNumber: 35, workflowId: "demo" })).toEqual({
      ok: false,
      reason: "ACTIVE_RUN_EXISTS",
    });
  });
});

it("persists a quality execution plan while retaining the original template hash", () => {
  const r = setup([
    step("analyze", []),
    step("implement", ["analyze"]),
    { ...step("verify", ["implement"]), role: "qa" },
    { ...step("review", ["verify"]), role: "reviewer" },
  ]);
  const result = planRun(
    {
      ...r.deps,
      qualityTask: {
        context: {
          taskSnapshot: { issueNumber: 35, title: "Feature", body: "Issue data" },
          acceptanceCriteria: ["measurable"],
          businessBaselineHash: "a".repeat(64),
          inputArtifacts: [],
          previousFindings: [],
          allowedScope: { paths: ["src/interfaces/cli/commands/task.ts"] },
          approvalRefs: ["approved-35"],
        },
        complexity: {
          workflow: "feature",
          workType: "task",
          area: "tooling",
          priority: "P2",
          acCount: 1,
          labels: [],
          complexity: "low",
        },
        workspace: { taskId: "omi-035", slug: "feature" },
      },
    },
    { issueNumber: 35, workflowId: "demo" },
  );
  expect(result).toMatchObject({
    ok: true,
    steps: [
      { stepId: "implement", status: "ready" },
      { stepId: "review", status: "pending" },
    ],
  });
  expect(r.created[0]).toHaveProperty("qualityPlan.scopeEvidence", "issue:35");
});

it("reads the approved task boundary before planning runtime work", async () => {
  const r = setup();
  let reads = 0;
  const module = await import("../../../../../src/application/use-cases/runs/plan-run.ts");
  expect(module).toHaveProperty("planRunWithTask", expect.any(Function));
  await module
    .planRunWithTask(
      {
        ...r.deps,
        readTask: (id: string) => {
          reads += 1;
          expect(id).toBe("task-35");
          return Promise.reject(new Error("BUSINESS_APPROVAL_REQUIRED"));
        },
      },
      { issueNumber: 35, workflowId: "demo" },
    )
    .catch(() => undefined);
  expect(reads).toBe(1);
  expect(r.created).toEqual([]);
});

it("keeps the original analysis graph when the Issue has no recorded scope approval yet", async () => {
  const r = setup([step("analyze", []), step("implement", ["analyze"])]);
  const { planRunWithTask } =
    await import("../../../../../src/application/use-cases/runs/plan-run.ts");
  const { DispatchPlanningError } =
    await import("../../../../../src/application/services/dispatch-planning-error.ts");
  expect(
    await planRunWithTask(
      {
        ...r.deps,
        readTask: () => Promise.reject(new DispatchPlanningError("BUSINESS_APPROVAL_REQUIRED")),
      },
      { issueNumber: 35, workflowId: "demo" },
    ),
  ).toMatchObject({
    ok: true,
    steps: [
      { stepId: "analyze", status: "ready" },
      { stepId: "implement", status: "pending" },
    ],
  });
});
