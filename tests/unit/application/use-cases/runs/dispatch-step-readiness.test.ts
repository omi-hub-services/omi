import { describe, expect, it, vi } from "vitest";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { FakeBoard, task } from "../tasks/intake-fakes.ts";
import { dispatchInput, rig } from "./run-fakes.ts";

// dispatchInput() uses taskSnapshot.issueNumber 20.
describe("dispatchStep readiness gate (task branch creation)", () => {
  it("creates the branch and dispatches when the task passes the gate", async () => {
    const r = rig();
    const create = vi.spyOn(r.workspaces, "createTask");
    const board = new FakeBoard([task({ number: 20, status: "In Progress" })]);
    expect(await dispatchStep({ ...r.deps, board }, dispatchInput())).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses with every reason and creates no branch, attempt or worker when a field is missing", async () => {
    const r = rig();
    const create = vi.spyOn(r.workspaces, "createTask");
    const board = new FakeBoard([task({ number: 20, role: null, body: "no criteria" })]);
    const result = await dispatchStep({ ...r.deps, board }, dispatchInput());
    expect(result).toEqual({
      ok: false,
      reason: "TASK_NOT_READY",
      detail:
        "Plan Key must match exactly one body marker; missing Role; Acceptance criteria needs at least one top-level checkbox; Implementation map needs at least one valid relative path",
    });
    expect(create).not.toHaveBeenCalled();
    expect(r.executor.started).toEqual([]);
    expect(r.steps.rows.get("step-1")?.status).toBe("ready");
  });

  it("refuses a task that is not on the Project", async () => {
    const r = rig();
    const create = vi.spyOn(r.workspaces, "createTask");
    const result = await dispatchStep({ ...r.deps, board: new FakeBoard() }, dispatchInput());
    expect(result).toEqual({
      ok: false,
      reason: "TASK_NOT_READY",
      detail: "#20 is not on the Project",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a missing Plan Key before any branch exists", async () => {
    const r = rig();
    const board = new FakeBoard([task({ number: 20, planKey: null })]);
    expect(await dispatchStep({ ...r.deps, board }, dispatchInput())).toMatchObject({
      ok: false,
      reason: "TASK_NOT_READY",
      detail: expect.stringContaining("missing Plan Key") as unknown,
    });
  });

  it("keeps working without a board, as a project that has not opted in to the live gate", async () => {
    const r = rig();
    expect(await dispatchStep(r.deps, dispatchInput())).toMatchObject({ ok: true });
  });
});
