import { describe, expect, it } from "vitest";
import type { ReworkCycle } from "../../../../src/domain/runs/rework-cycle.ts";
import type { StepStatus } from "../../../../src/domain/runs/step-run.ts";
import {
  buildWorkflowDiagram,
  compareLoadedSkills,
  orderDiagramNodes,
  type DiagramWorkflow,
} from "../../../../src/domain/workflows/workflow-diagram.ts";

const step = (
  id: string,
  role: string,
  needs: string[] = [],
  skills: string[] = [],
  rules: string[] = [],
) => ({ id, role, needs, skills, rules });

/** Mirrors templates/project/workflows/feature.yaml: gates before and after steps. */
const FEATURE: DiagramWorkflow = {
  id: "feature",
  steps: [
    step("analyze", "analyst"),
    step("implement", "developer", ["analyze"], ["test-driven-development"], ["project-baseline"]),
    step("verify", "qa", ["implement"]),
    step("review", "reviewer", ["verify"]),
  ],
  gates: [
    { id: "scope-approved", before: "implement" },
    { id: "ready-to-merge", after: "review" },
  ],
};

const NO_REWORK: ReworkCycle = { phase: "before-architect", rework: 0, of: 2, architect: "none" };
const statuses = (entries: Record<string, StepStatus>) => new Map(Object.entries(entries));
const ids = (nodes: readonly { id: string }[]) => nodes.map((n) => n.id);
const stateOf = (nodes: readonly { id: string; state: string }[], id: string) =>
  nodes.find((n) => n.id === id)?.state;

describe("hold with several failed steps", () => {
  it("sits on the earliest failed step: a later failed review is an old verdict still to re-run", () => {
    const diagram = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({
        analyze: "succeeded",
        implement: "succeeded",
        verify: "failed",
        review: "failed",
      }),
      cycle: NO_REWORK,
      failures: 1,
      hold: { kind: "waiting-po" },
    });
    expect(stateOf(diagram.nodes, "verify")).toBe("waiting-po");
    expect(stateOf(diagram.nodes, "review")).toBe("failed");
    expect(diagram.nodes.filter((n) => n.state === "waiting-po")).toHaveLength(1);
  });
});

describe("orderDiagramNodes", () => {
  it("orders steps by needs and puts each gate before or after its step", () => {
    const reversed: DiagramWorkflow = { ...FEATURE, steps: [...FEATURE.steps].reverse() };
    expect(orderDiagramNodes(reversed).map((n) => n.id)).toEqual([
      "analyze",
      "scope-approved",
      "implement",
      "verify",
      "review",
      "ready-to-merge",
    ]);
  });

  it("falls back to file order for a cycle instead of looping", () => {
    const cyclic: DiagramWorkflow = {
      id: "x",
      steps: [step("a", "developer", ["b"]), step("b", "qa", ["a"])],
      gates: [],
    };
    expect(orderDiagramNodes(cyclic).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("carries role, skills and rules of a step and none for a gate", () => {
    const nodes = orderDiagramNodes(FEATURE);
    expect(nodes.find((n) => n.id === "implement")).toMatchObject({
      kind: "step",
      role: "developer",
      skills: ["test-driven-development"],
      rules: ["project-baseline"],
    });
    expect(nodes.find((n) => n.id === "ready-to-merge")).toMatchObject({
      kind: "gate",
      skills: [],
      rules: [],
    });
  });
});

describe("buildWorkflowDiagram", () => {
  it("draws the template's steps and gates, not a fixed lifecycle", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({}),
      cycle: NO_REWORK,
      failures: 0,
    });
    expect(ids(nodes)).toEqual([
      "analyze",
      "scope-approved",
      "implement",
      "verify",
      "review",
      "ready-to-merge",
    ]);
  });

  it("marks succeeded steps done, the running step current and later steps todo", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded", implement: "running" }),
      cycle: NO_REWORK,
      failures: 0,
    });
    expect(stateOf(nodes, "analyze")).toBe("done");
    expect(stateOf(nodes, "scope-approved")).toBe("done");
    expect(stateOf(nodes, "implement")).toBe("current");
    expect(stateOf(nodes, "verify")).toBe("todo");
    expect(stateOf(nodes, "ready-to-merge")).toBe("todo");
  });

  it("marks a gate after a step done only once that step succeeded", () => {
    const all = statuses({
      analyze: "succeeded",
      implement: "succeeded",
      verify: "succeeded",
      review: "succeeded",
    });
    const done = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: all,
      cycle: NO_REWORK,
      failures: 0,
    });
    expect(stateOf(done.nodes, "ready-to-merge")).toBe("done");
    const running = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ ...Object.fromEntries(all), review: "running" }),
      cycle: NO_REWORK,
      failures: 0,
    });
    expect(stateOf(running.nodes, "ready-to-merge")).toBe("todo");
  });

  it("shows a failed step as failed", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded", implement: "succeeded", verify: "failed" }),
      cycle: NO_REWORK,
      failures: 0,
    });
    expect(stateOf(nodes, "verify")).toBe("failed");
  });

  it("shows a step waiting for approval as current with the reason as sub-label", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded", implement: "waiting_approval" }),
      cycle: NO_REWORK,
      failures: 0,
    });
    expect(nodes.find((n) => n.id === "implement")).toMatchObject({
      state: "current",
      sub: "waiting approval",
    });
  });

  it("draws no rework edge without a failure", () => {
    const { reworkEdge } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({}),
      cycle: NO_REWORK,
      failures: 0,
    });
    expect(reworkEdge).toBeUndefined();
  });

  it("draws the rework edge from the reviewer step back to the developer step", () => {
    const { reworkEdge, nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded", implement: "running" }),
      cycle: { phase: "before-architect", rework: 1, of: 2, architect: "none" },
      failures: 1,
    });
    expect(reworkEdge).toEqual({ from: "review", to: "implement", failures: 1 });
    expect(nodes.find((n) => n.id === "implement")?.sub).toBe("rework 1/2");
    expect(ids(nodes)).not.toContain("architect");
  });

  it("adds an Architect node that needs a call from the 2nd failure", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded", implement: "succeeded", verify: "succeeded" }),
      cycle: { phase: "architect", rework: 2, of: 2, architect: "needed" },
      failures: 2,
    });
    expect(nodes.find((n) => n.id === "architect")).toMatchObject({
      kind: "architect",
      state: "current",
      sub: "needs a call",
    });
  });

  it("lights the Architect node once it was called and labels the reworks after it", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded", implement: "running" }),
      cycle: { phase: "after-architect", rework: 1, of: 2, architect: "called" },
      failures: 3,
    });
    expect(nodes.find((n) => n.id === "architect")).toMatchObject({ state: "done" });
    expect(nodes.find((n) => n.id === "implement")?.sub).toBe("rework 1/2 (after Architect)");
  });

  it("adds an Ask PO node after two more failures and keeps the rework edge", () => {
    const { nodes, reworkEdge } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded", implement: "succeeded", verify: "succeeded" }),
      cycle: { phase: "escalate-po", rework: 2, of: 2, architect: "called" },
      failures: 4,
    });
    expect(nodes.find((n) => n.id === "ask-po")).toMatchObject({
      kind: "ask-po",
      state: "waiting-po",
    });
    expect(reworkEdge).toMatchObject({ failures: 4 });
  });

  it("draws a blocked task's current step as blocked with the open blockers", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded" }),
      cycle: NO_REWORK,
      failures: 0,
      hold: { kind: "blocked", by: [12, 14, 15] },
    });
    expect(nodes.find((n) => n.id === "implement")).toMatchObject({
      state: "blocked",
      sub: "blocked by #12 +2",
    });
    expect(stateOf(nodes, "analyze")).toBe("done");
  });

  it("draws a task waiting for the PO at its current step", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({ analyze: "succeeded", implement: "waiting_approval" }),
      cycle: NO_REWORK,
      failures: 0,
      hold: { kind: "waiting-po" },
    });
    expect(nodes.find((n) => n.id === "implement")).toMatchObject({
      state: "waiting-po",
      sub: "waiting PO",
    });
  });

  it("draws every node done when all steps succeeded", () => {
    const { nodes } = buildWorkflowDiagram({
      workflow: FEATURE,
      steps: statuses({
        analyze: "succeeded",
        implement: "succeeded",
        verify: "succeeded",
        review: "succeeded",
      }),
      cycle: { phase: "passed", rework: 0, of: 2, architect: "none" },
      failures: 0,
    });
    expect(nodes.every((n) => n.state === "done")).toBe(true);
  });
});

describe("compareLoadedSkills", () => {
  it("reports a loaded skill the step does not list, and where the template gives it", () => {
    const check = compareLoadedSkills(FEATURE, "implement", ["test-driven-development", "extra"]);
    expect(check).toEqual({
      expected: ["test-driven-development"],
      missing: [],
      extra: [{ name: "extra", template: null }],
    });
  });

  it("reports a template skill that was not loaded", () => {
    expect(compareLoadedSkills(FEATURE, "implement", [])?.missing).toEqual([
      "test-driven-development",
    ]);
  });

  it("is undefined for an id that is not a step", () => {
    expect(compareLoadedSkills(FEATURE, "ready-to-merge", [])).toBeUndefined();
  });
});
