import { describe, expect, it } from "vitest";
import { findDependencyCycle } from "../../../../src/domain/shared/graph.ts";
import { ALLOWED, decide } from "../../../../src/domain/shared/decision.ts";
import { applyTransition, ruleBuilder } from "../../../../src/domain/shared/transition.ts";

type State = "a" | "b" | "c";
type Event = { type: "go"; ok: boolean } | { type: "stop" };
const rule = ruleBuilder<State, Event, "NOT_OK">();
const rules = [rule("a", "go", "b", (e) => (e.ok ? undefined : "NOT_OK")), rule("b", "stop", "c")];

describe("applyTransition", () => {
  it("moves to the target when the precondition holds", () => {
    expect(applyTransition(rules, "a", { type: "go", ok: true })).toEqual({
      ok: true,
      from: "a",
      to: "b",
    });
  });

  it("refuses with the precondition's reason code and names the source state", () => {
    expect(applyTransition(rules, "a", { type: "go", ok: false })).toEqual({
      ok: false,
      from: "a",
      reason: "NOT_OK",
    });
  });

  it("refuses an event with no rule for that state", () => {
    expect(applyTransition(rules, "b", { type: "go", ok: true })).toEqual({
      ok: false,
      from: "b",
      reason: "TRANSITION_NOT_ALLOWED",
    });
    expect(applyTransition(rules, "c", { type: "stop" }).ok).toBe(false);
  });
});

describe("decide", () => {
  it("allows when nothing refused", () => {
    expect(decide([])).toBe(ALLOWED);
  });

  it("keeps the first refusal as the primary reason and every refusal in order", () => {
    expect(decide(["X", "Y"] as const)).toEqual({
      allowed: false,
      reason: "X",
      reasons: ["X", "Y"],
    });
  });
});

describe("findDependencyCycle", () => {
  const graph = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

  it("returns undefined for an acyclic graph, including a diamond", () => {
    expect(
      findDependencyCycle(graph({ a: [], b: ["a"], c: ["a"], d: ["b", "c"] })),
    ).toBeUndefined();
  });

  it("returns the cycle path, starting and ending on the same node", () => {
    expect(findDependencyCycle(graph({ a: ["b"], b: ["c"], c: ["a"] }))).toEqual([
      "a",
      "b",
      "c",
      "a",
    ]);
  });

  it("finds a self loop", () => {
    expect(findDependencyCycle(graph({ a: ["a"] }))).toEqual(["a", "a"]);
  });

  it("ignores edges to unknown nodes", () => {
    expect(findDependencyCycle(graph({ a: ["ghost"] }))).toBeUndefined();
  });
});
