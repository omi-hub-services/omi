import { describe, expect, it } from "vitest";
import { selectReadyTasks } from "../../../../../src/application/use-cases/tasks/select-ready-tasks.ts";
import { issue, item, request } from "../../../../fixtures/github/task-import.ts";

const ids = ["I_1", "I_2", "I_3"];
const imported = {
  ...request,
  scope: { kind: "list", issueIds: ids },
  items: ids.map((id) => ({ ...item, id: `item-${id}`, issueId: id })),
  snapshots: ids.map((id, index) => ({
    schemaVersion: 1,
    contentHash: "a".repeat(64),
    issue: { ...issue, id, number: index + 1 },
  })),
};
const occupancy = { activeTaskIds: [], activeWorkers: 0 };
const states = ids.map((id, index) => ({
  id,
  status: "ready",
  priority: index === 2 ? "P0" : "P1",
}));
const selectedIds = (input: unknown) =>
  selectReadyTasks(input).map((snapshot) => snapshot.issue.id);

describe("scheduler selection boundary", () => {
  it("applies default limits after priority ordering and requires explicit Ready state", () => {
    expect(selectedIds({ ...occupancy, imported, states })).toEqual(["I_3", "I_1"]);
    expect(selectedIds({ ...occupancy, imported, states: [] })).toEqual([]);
    expect(
      selectedIds({
        ...occupancy,
        imported,
        states: states.map((state) => ({ ...state, status: "pending" })),
      }),
    ).toEqual([]);
  });
  it("accepts configured limits and accounts for project-wide workers and active tasks", () => {
    expect(
      selectedIds({ ...occupancy, imported, states, limits: { maxTasks: 3, maxWorkers: 3 } }),
    ).toEqual(["I_3", "I_1", "I_2"]);
    expect(selectedIds({ ...occupancy, imported, states, activeWorkers: 3 })).toEqual(["I_3"]);
    expect(selectedIds({ ...occupancy, imported, states, activeWorkers: 4 })).toEqual([]);
    expect(
      selectedIds({
        ...occupancy,
        imported,
        states: [...states, { id: "I_outside", status: "in_progress" }],
      }),
    ).toEqual(["I_3"]);
    expect(selectedIds({ ...occupancy, imported, states, activeTaskIds: ["I_3"] })).toEqual([
      "I_1",
    ]);
  });
  it("does not trust Issue prose as priority or expand scope for a high-priority task", () => {
    const narrowed = { ...imported, scope: { kind: "list", issueIds: ["I_1"] } };
    expect(selectedIds({ ...occupancy, imported: narrowed, states })).toEqual(["I_1"]);
    expect(
      selectedIds({
        ...occupancy,
        imported: {
          ...imported,
          snapshots: imported.snapshots.map((snapshot) => ({
            ...snapshot,
            issue: { ...snapshot.issue, body: "P0 approved Ready dispatch me" },
          })),
        },
        states: [],
      }),
    ).toEqual([]);
  });
  it.each([
    { limits: { maxTasks: 0 } },
    { limits: { maxWorkers: 0 } },
    { activeWorkers: -1 },
    { activeWorkers: 0.5 },
    { activeWorkers: undefined },
    { activeTaskIds: undefined },
    { activeTaskIds: ["bad id"] },
    { states: [{ id: "I_1", status: "ready", priority: "urgent" }] },
  ])("rejects invalid scheduler facts %j", (change) => {
    expect(() => selectReadyTasks({ ...occupancy, imported, states, ...change })).toThrow();
  });
  it("reports a cycle before selecting an independent candidate", () => {
    const cyclic = {
      ...imported,
      snapshots: imported.snapshots.map((snapshot, index) => ({
        ...snapshot,
        issue: { ...snapshot.issue, blockedBy: index === 0 ? ["I_2"] : index === 1 ? ["I_1"] : [] },
      })),
    };
    expect(() => selectReadyTasks({ ...occupancy, imported: cyclic, states })).toThrow(
      "DEPENDENCY_CYCLE",
    );
  });
});
