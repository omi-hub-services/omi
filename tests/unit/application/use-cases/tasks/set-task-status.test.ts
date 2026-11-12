import { describe, expect, it } from "vitest";
import { setTaskStatus } from "../../../../../src/application/use-cases/tasks/set-task-status.ts";
import { FakeBoard, task } from "./intake-fakes.ts";

describe("setTaskStatus", () => {
  it.each(["Ready", "In Progress"] as const)("moves a ready task to %s", async (status) => {
    const board = new FakeBoard([task()]);
    await expect(setTaskStatus({ board }, { issueNumber: 10, status })).resolves.toEqual({
      kind: "set",
      issueNumber: 10,
      status,
    });
    expect(board.writes).toEqual([{ issueNumber: 10, status }]);
  });

  it.each(["Ready", "In Progress"] as const)(
    "refuses %s with every reason and writes nothing when the task is not ready",
    async (status) => {
      const board = new FakeBoard([task({ planKey: null, role: null, body: "" })]);
      const result = await setTaskStatus({ board }, { issueNumber: 10, status });
      expect(result).toMatchObject({ kind: "refused" });
      expect(result.kind === "refused" && result.reasons).toEqual([
        "missing Plan Key",
        "Plan Key must match exactly one body marker",
        "missing Role",
        "Acceptance criteria needs at least one top-level checkbox",
      ]);
      expect(board.writes).toEqual([]);
    },
  );

  it("still refuses a task that is already at the requested status but fails the gate", async () => {
    const board = new FakeBoard([task({ status: "Ready", area: null })]);
    const result = await setTaskStatus({ board }, { issueNumber: 10, status: "Ready" });
    expect(result).toEqual({ kind: "refused", reasons: ["missing Area"] });
    expect(board.writes).toEqual([]);
  });

  it("reports done without writing when a ready task is already at the status", async () => {
    const board = new FakeBoard([task({ status: "In Progress" })]);
    const result = await setTaskStatus({ board }, { issueNumber: 10, status: "In Progress" });
    expect(result).toEqual({ kind: "done", issueNumber: 10, status: "In Progress" });
    expect(board.writes).toEqual([]);
  });

  it("refuses a task that is not on the Project", async () => {
    const board = new FakeBoard();
    expect(await setTaskStatus({ board }, { issueNumber: 99, status: "Ready" })).toEqual({
      kind: "refused",
      reasons: ["#99 is not on the Project"],
    });
  });

  it("does not offer statuses that carry no gate", async () => {
    const board = new FakeBoard([task()]);
    await expect(setTaskStatus({ board }, { issueNumber: 10, status: "Done" })).rejects.toThrow();
    expect(board.writes).toEqual([]);
  });
});
