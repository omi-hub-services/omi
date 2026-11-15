import { describe, expect, it } from "vitest";
import { promoteTask } from "../../../../../src/application/use-cases/tasks/promote-task.ts";
import { FakeBoard, task } from "./intake-fakes.ts";

describe("promoteTask with an Issue number", () => {
  it("moves a Backlog task whose blockers are all closed to Ready", async () => {
    const board = new FakeBoard([task({ blockers: [{ number: 3, state: "CLOSED" }] })]);
    expect(await promoteTask({ board }, { issueNumber: 10, dryRun: false })).toEqual({
      kind: "promoted",
      issueNumber: 10,
    });
    expect(board.writes).toEqual([{ issueNumber: 10, status: "Ready" }]);
  });

  it("refuses while a blocker is open and writes nothing", async () => {
    const board = new FakeBoard([task({ blockers: [{ number: 3, state: "OPEN" }] })]);
    expect(await promoteTask({ board }, { issueNumber: 10, dryRun: false })).toEqual({
      kind: "refused",
      reason: "#10: blocked by #3",
    });
    expect(board.writes).toEqual([]);
  });

  it("refuses a task that fails the readiness gate", async () => {
    const board = new FakeBoard([task({ workflow: null })]);
    expect(await promoteTask({ board }, { issueNumber: 10, dryRun: false })).toEqual({
      kind: "refused",
      reason: "#10: missing Workflow",
    });
    expect(board.writes).toEqual([]);
  });

  it("reports done and writes nothing when the task is already Ready", async () => {
    const board = new FakeBoard([task({ status: "Ready" })]);
    expect(await promoteTask({ board }, { issueNumber: 10, dryRun: false })).toMatchObject({
      kind: "done",
    });
    expect(board.writes).toEqual([]);
  });

  it("refuses an Issue that is not on the Project", async () => {
    expect(
      await promoteTask({ board: new FakeBoard() }, { issueNumber: 10, dryRun: false }),
    ).toEqual({ kind: "refused", reason: "#10 is not on the Project" });
  });

  it("previews with --dry-run and writes nothing", async () => {
    const board = new FakeBoard([task()]);
    expect(await promoteTask({ board }, { issueNumber: 10, dryRun: true })).toEqual({
      kind: "would_promote",
      issueNumber: 10,
    });
    expect(board.writes).toEqual([]);
  });
});

describe("promoteTask without an Issue number", () => {
  it("promotes the first eligible Backlog task by Priority, then Issue number", async () => {
    const board = new FakeBoard([
      task({ number: 30, priority: "P2" }),
      task({ number: 12, priority: "P1", blockers: [{ number: 3, state: "OPEN" }] }),
      task({ number: 21, priority: "P1" }),
      task({ number: 20, priority: "P1" }),
    ]);
    expect(await promoteTask({ board }, { dryRun: false })).toEqual({
      kind: "promoted",
      issueNumber: 20,
    });
    expect(board.writes).toEqual([{ issueNumber: 20, status: "Ready" }]);
  });

  it("skips a first-in-order task that fails the gate and takes the next eligible one", async () => {
    const board = new FakeBoard([
      task({ number: 5, priority: "P0", role: null }),
      task({ number: 6, priority: "P1" }),
    ]);
    expect(await promoteTask({ board }, { dryRun: false })).toEqual({
      kind: "promoted",
      issueNumber: 6,
    });
  });

  it("says nothing is eligible and writes nothing when no Backlog task qualifies", async () => {
    const board = new FakeBoard([task({ blockers: [{ number: 3, state: "OPEN" }] })]);
    expect(await promoteTask({ board }, { dryRun: false })).toEqual({ kind: "none" });
    expect(board.writes).toEqual([]);
  });

  it("previews the pick with --dry-run", async () => {
    const board = new FakeBoard([task({ number: 8 })]);
    expect(await promoteTask({ board }, { dryRun: true })).toEqual({
      kind: "would_promote",
      issueNumber: 8,
    });
    expect(board.writes).toEqual([]);
  });
});
