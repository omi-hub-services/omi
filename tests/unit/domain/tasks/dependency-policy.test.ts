import { describe, expect, it } from "vitest";
import {
  classifyDependencies,
  isTaskInScope,
  isTaskImportable,
  validateTaskDependencies,
} from "../../../../src/domain/tasks/dependency-policy.ts";
import type { TaskNode } from "../../../../src/domain/tasks/dependency-policy.ts";

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
