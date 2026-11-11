import { describe, expect, it } from "vitest";
import {
  classifyDependencies,
  selectTaskBatch,
  isTaskInScope,
  isTaskImportable,
  validateTaskDependencies,
} from "../../../../src/domain/tasks/dependency-policy.ts";
import type { TaskNode, SchedulingTask } from "../../../../src/domain/tasks/dependency-policy.ts";

const node = (id: string, status: TaskNode["status"], blockedBy: string[] = []): TaskNode => ({
  id,
  status,
  blockedBy,
});

describe("validateTaskDependencies", () => {
  it("accepts a valid graph", () => {
    expect(validateTaskDependencies([node("a", "done"), node("b", "pending", ["a"])])).toEqual([]);
  });

  it("names the cycle that blocks assignment", () => {
    const issues = validateTaskDependencies([
      node("a", "pending", ["c"]),
      node("b", "pending", ["a"]),
      node("c", "pending", ["b"]),
    ]);
    expect(issues).toEqual([{ code: "DEPENDENCY_CYCLE", path: ["a", "c", "b", "a"] }]);
  });

  it("reports a self dependency once, not also as a cycle", () => {
    expect(validateTaskDependencies([node("a", "pending", ["a"])])).toEqual([
      { code: "SELF_DEPENDENCY", taskId: "a" },
    ]);
  });

  it("reports unknown predecessors and duplicate ids", () => {
    expect(
      validateTaskDependencies([node("a", "pending", ["ghost"]), node("a", "pending")]),
    ).toEqual([
      { code: "DUPLICATE_TASK", taskId: "a" },
      { code: "UNKNOWN_DEPENDENCY", taskId: "a", dependencyId: "ghost" },
    ]);
  });
});

describe("classifyDependencies", () => {
  const byId = (tasks: TaskNode[]) => new Map(tasks.map((t) => [t.id, t]));

  it("is satisfied with no predecessors or all done", () => {
    const tasks = [node("a", "done"), node("b", "pending", ["a"]), node("c", "ready")];
    const map = byId(tasks);
    expect(classifyDependencies(node("c", "ready"), map)).toEqual({ kind: "satisfied" });
    expect(classifyDependencies(node("b", "pending", ["a"]), map)).toEqual({ kind: "satisfied" });
  });

  it("waits while a predecessor is unfinished", () => {
    const map = byId([node("a", "in_progress"), node("x", "ready")]);
    expect(classifyDependencies(node("x", "ready", ["a"]), map)).toEqual({
      kind: "waiting",
      waitingOn: ["a"],
    });
  });

  it("blocks on a stopped, dependency-blocked or cancelled predecessor, even if another is waiting", () => {
    const map = byId([
      node("a", "blocked"),
      node("b", "blocked_by_dependency"),
      node("c", "cancelled"),
      node("d", "in_progress"),
    ]);
    expect(classifyDependencies(node("x", "pending", ["a", "b", "c", "d"]), map)).toEqual({
      kind: "blocked",
      blockedOn: ["a", "b", "c"],
    });
  });

  it("leaves a task independent of the stopped one untouched", () => {
    const map = byId([node("a", "blocked"), node("free", "ready")]);
    expect(classifyDependencies(node("free", "ready"), map)).toEqual({ kind: "satisfied" });
  });
});

describe("task scope and minimum import eligibility", () => {
  const facts = {
    id: "issue",
    milestoneId: "milestone",
    iterations: [{ fieldId: "field", iterationId: "iteration" }],
  };
  it("matches scope by opaque identity, including the iteration field", () => {
    expect(isTaskInScope(facts, { kind: "milestone", milestoneId: "milestone" })).toBe(true);
    expect(isTaskInScope(facts, { kind: "milestone", milestoneId: "other" })).toBe(false);
    expect(
      isTaskInScope(facts, { kind: "iteration", fieldId: "field", iterationId: "iteration" }),
    ).toBe(true);
    expect(
      isTaskInScope(facts, { kind: "iteration", fieldId: "other", iterationId: "iteration" }),
    ).toBe(false);
    expect(
      isTaskInScope(facts, { kind: "iteration", fieldId: "field", iterationId: "other" }),
    ).toBe(false);
    expect(isTaskInScope(facts, { kind: "list", issueIds: [] })).toBe(false);
    expect(isTaskInScope(facts, { kind: "list", issueIds: ["issue"] })).toBe(true);
  });
  it("requires a real, active, open Issue with nonblank title and body", () => {
    const task = { kind: "Issue", archived: false, state: "OPEN", title: "Title", body: "Body" };
    expect(isTaskImportable(task)).toBe(true);
    for (const change of [
      { kind: "DraftIssue" },
      { archived: true },
      { state: "CLOSED" },
      { title: " " },
      { body: "\n" },
    ]) {
      expect(isTaskImportable({ ...task, ...change })).toBe(false);
    }
  });
});

describe("bounded task selection", () => {
  const task = (id: string, overrides: Partial<SchedulingTask> = {}): SchedulingTask => ({
    id,
    status: "ready",
    blockedBy: [],
    priority: "P1",
    eligible: true,
    ...overrides,
  });
  const capacity = { activeTaskIds: [], activeWorkers: 0, maxTasks: 2, maxWorkers: 4 };
  const tasks = [task("c"), task("b", { priority: "P0" }), task("a", { priority: "P0" })];

  it("orders priority then identity, independently of input order", () => {
    expect(selectTaskBatch(tasks, capacity)).toEqual(["a", "b"]);
    expect(selectTaskBatch([...tasks].reverse(), capacity)).toEqual(["a", "b"]);
    expect(
      selectTaskBatch([task("a", { priority: null }), task("z", { priority: "P2" })], capacity),
    ).toEqual(["z", "a"]);
  });
  it("admits only Ready, eligible tasks", () => {
    expect(
      selectTaskBatch(
        [
          task("outside", { eligible: false, priority: "P0" }),
          ...(
            [
              "pending",
              "in_progress",
              "blocked",
              "blocked_by_dependency",
              "done",
              "cancelled",
            ] as const
          ).map((status) => task(status, { status })),
          task("ready"),
        ],
        { ...capacity, maxTasks: 10 },
      ),
    ).toEqual(["ready"]);
  });
  it("counts active tasks outside scope, deduplicates reservations and supports configured task limits", () => {
    expect(selectTaskBatch(tasks, { ...capacity, activeTaskIds: ["outside", "outside"] })).toEqual([
      "a",
    ]);
    expect(selectTaskBatch(tasks, { ...capacity, activeTaskIds: ["outside", "other"] })).toEqual(
      [],
    );
    expect(selectTaskBatch(tasks, { ...capacity, maxTasks: 3 })).toEqual(["a", "b", "c"]);
    expect(selectTaskBatch(tasks, { ...capacity, maxTasks: 1 })).toEqual(["a"]);
    expect(selectTaskBatch(tasks, { ...capacity, activeTaskIds: ["a"] })).toEqual(["b"]);
  });
  it("counts all project workers and reservations independently of task capacity", () => {
    expect(selectTaskBatch(tasks, { ...capacity, activeWorkers: 3 })).toEqual(["a"]);
    expect(selectTaskBatch(tasks, { ...capacity, activeWorkers: 4 })).toEqual([]);
    expect(selectTaskBatch(tasks, { ...capacity, activeWorkers: 5 })).toEqual([]);
    expect(selectTaskBatch(tasks, { ...capacity, maxWorkers: 1 })).toEqual(["a"]);
    expect(
      selectTaskBatch(tasks, { ...capacity, maxTasks: 3, maxWorkers: 5, activeWorkers: 2 }),
    ).toEqual(["a", "b", "c"]);
  });
  it("propagates blocked and unfinished dependencies through the DAG without blocking independent work", () => {
    const chain = [
      task("root", { status: "blocked", eligible: false }),
      task("middle", { blockedBy: ["root"] }),
      task("leaf", { blockedBy: ["middle"] }),
      task("free"),
    ];
    const byId = new Map(chain.map((entry) => [entry.id, entry]));
    const leaf = chain[2];
    if (leaf === undefined) throw new Error("missing leaf");
    expect(classifyDependencies(leaf, byId)).toEqual({ kind: "blocked", blockedOn: ["middle"] });
    expect(selectTaskBatch(chain, capacity)).toEqual(["free"]);
    for (const status of [
      "pending",
      "ready",
      "in_progress",
      "blocked_by_dependency",
      "cancelled",
    ] as const) {
      expect(
        selectTaskBatch([task("root", { status, eligible: false }), ...chain.slice(1)], capacity),
      ).toEqual(["free"]);
    }
    expect(
      selectTaskBatch(
        [
          task("root", { status: "done", eligible: false }),
          task("middle", { status: "done", blockedBy: ["root"] }),
          ...chain.slice(2),
        ],
        capacity,
      ),
    ).toEqual(["free", "leaf"]);
  });
  it("rejects cycles, unknown edges and duplicates before returning any candidates", () => {
    expect(() =>
      selectTaskBatch(
        [task("a", { blockedBy: ["b"] }), task("b", { blockedBy: ["a"] }), task("free")],
        capacity,
      ),
    ).toThrow("DEPENDENCY_CYCLE");
    expect(() => selectTaskBatch([task("a", { blockedBy: ["missing"] })], capacity)).toThrow(
      "UNKNOWN_DEPENDENCY",
    );
    expect(() => selectTaskBatch([task("a"), task("a")], capacity)).toThrow("DUPLICATE_TASK");
  });
  it("refuses invalid capacity instead of silently disabling limits", () => {
    for (const change of [
      { maxTasks: 0 },
      { maxWorkers: -1 },
      { activeWorkers: -1 },
      { activeWorkers: 0.5 },
    ]) {
      expect(() => selectTaskBatch(tasks, { ...capacity, ...change })).toThrow(
        "Invalid scheduling capacity",
      );
    }
  });
});
