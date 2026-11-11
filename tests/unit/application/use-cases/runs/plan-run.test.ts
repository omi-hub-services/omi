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
