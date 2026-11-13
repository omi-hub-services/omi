import { describe, expect, it } from "vitest";
import type { PromotionCandidate } from "../../../../src/domain/tasks/promotion-policy.ts";
import {
  groupTasksByStatus,
  selectUnblockedReady,
  suggestNextTask,
} from "../../../../src/domain/tasks/next-task-policy.ts";

function task(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    number: 10,
    state: "OPEN",
    status: "Ready",
    planKey: "OMI-010",
    body: "",
    priority: "P1",
    workType: "Task",
    workflow: "feature",
    role: "Developer",
    area: "tooling",
    milestone: "M1",
    blockers: [],
    blockersTruncated: false,
    ...overrides,
  };
}

describe("selectUnblockedReady", () => {
  it("keeps Ready tasks whose blockers are all closed", () => {
    const tasks = [
      task({ number: 1, blockers: [{ number: 9, state: "CLOSED" }] }),
      task({ number: 2, blockers: [{ number: 8, state: "OPEN" }] }),
    ];
    expect(selectUnblockedReady(tasks).map((t) => t.number)).toEqual([1]);
  });

  it("treats a truncated blocker list as blocked", () => {
    expect(selectUnblockedReady([task({ blockersTruncated: true })])).toEqual([]);
  });

  it("skips tasks that are not Ready, closed, or Epics", () => {
    const tasks = [
      task({ number: 1, status: "Backlog" }),
      task({ number: 2, state: "CLOSED" }),
      task({ number: 3, workType: "Epic" }),
      task({ number: 4 }),
    ];
    expect(selectUnblockedReady(tasks).map((t) => t.number)).toEqual([4]);
  });

  it("orders by Priority, then milestone (none last), then Issue number", () => {
    const tasks = [
      task({ number: 5, priority: "P2" }),
      task({ number: 4, priority: "P0", milestone: null }),
      task({ number: 3, priority: "P0", milestone: "M2" }),
      task({ number: 2, priority: "P0", milestone: "M1" }),
      task({ number: 1, priority: null }),
    ];
    expect(selectUnblockedReady(tasks).map((t) => t.number)).toEqual([2, 3, 4, 5, 1]);
  });
});

describe("suggestNextTask", () => {
  it("is the first unblocked Ready task", () => {
    expect(
      suggestNextTask([task({ number: 7, priority: "P2" }), task({ number: 6 })])?.number,
    ).toBe(6);
  });

  it("is undefined when nothing is unblocked and Ready", () => {
    expect(suggestNextTask([task({ status: "Backlog" })])).toBeUndefined();
  });
});

describe("groupTasksByStatus", () => {
  it("groups open non-Epic tasks by Project Status in the board's order, then by task order", () => {
    const groups = groupTasksByStatus([
      task({ number: 3, status: "In Progress" }),
      task({ number: 2, status: "Ready", priority: "P2" }),
      task({ number: 1, status: "Ready", priority: "P0" }),
      task({ number: 4, status: null }),
      task({ number: 5, status: "Done", state: "CLOSED" }),
      task({ number: 6, status: "Ready", workType: "Epic" }),
    ]);
    expect(groups.map((g) => [g.status, g.tasks.map((t) => t.number)])).toEqual([
      ["Ready", [1, 2]],
      ["In Progress", [3]],
      ["(no status)", [4]],
    ]);
  });
});
