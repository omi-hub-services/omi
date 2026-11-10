import { describe, expect, it } from "vitest";
import {
  evaluateRunCompletion,
  evaluateStepStartability,
  validateWorkflowGraph,
} from "../../../../src/domain/workflows/workflow-policy.ts";
import type { WorkflowGraph } from "../../../../src/domain/workflows/workflow-policy.ts";
import type { StepStatus } from "../../../../src/domain/runs/step-run.ts";
import type { GateStatus } from "../../../../src/domain/workflows/workflow-policy.ts";

const feature: WorkflowGraph = {
  steps: [
    { id: "analyze", needs: [] },
    { id: "implement", needs: ["analyze"] },
    { id: "verify", needs: ["implement"] },
    { id: "review", needs: ["verify"] },
  ],
  gates: [
    { id: "scope-approved", before: "implement" },
    { id: "ready-to-merge", after: "review" },
  ],
};

const steps = (entries: Record<string, StepStatus>) => new Map(Object.entries(entries));
const gates = (entries: Record<string, GateStatus>) => new Map(Object.entries(entries));

describe("validateWorkflowGraph", () => {
  it("accepts the feature workflow", () => {
    expect(validateWorkflowGraph(feature)).toEqual([]);
  });

  it("rejects a dependency cycle and names its path", () => {
    const graph: WorkflowGraph = {
      steps: [
        { id: "a", needs: ["b"] },
        { id: "b", needs: ["a"] },
      ],
      gates: [],
    };
    expect(validateWorkflowGraph(graph)).toEqual([
      { code: "DEPENDENCY_CYCLE", path: ["a", "b", "a"] },
    ]);
  });

  it("rejects a step that needs itself, once", () => {
    expect(validateWorkflowGraph({ steps: [{ id: "a", needs: ["a"] }], gates: [] })).toEqual([
      { code: "SELF_DEPENDENCY", stepId: "a" },
    ]);
  });

  it("rejects duplicates and references to unknown steps", () => {
    const graph: WorkflowGraph = {
      steps: [
        { id: "a", needs: ["ghost"] },
        { id: "a", needs: [] },
      ],
      gates: [
        { id: "g", before: "nowhere" },
        { id: "g", after: "a" },
      ],
    };
    expect(validateWorkflowGraph(graph)).toEqual([
      { code: "DUPLICATE_STEP", stepId: "a" },
      { code: "UNKNOWN_DEPENDENCY", stepId: "a", dependencyId: "ghost" },
      { code: "UNKNOWN_GATE_TARGET", gateId: "g", stepId: "nowhere" },
      { code: "DUPLICATE_GATE", gateId: "g" },
    ]);
  });
});

describe("evaluateStepStartability", () => {
  it("starts only the first step when nothing has run", () => {
    const result = evaluateStepStartability(feature, steps({}), gates({}));
    expect(result.filter((s) => s.startable).map((s) => s.stepId)).toEqual(["analyze"]);
  });

  it("holds a step behind its before-gate even when its predecessor succeeded", () => {
    const result = evaluateStepStartability(
      feature,
      steps({ analyze: "succeeded" }),
      gates({ "scope-approved": "open" }),
    );
    expect(result).toEqual([
      {
        stepId: "implement",
        startable: false,
        waitingOnSteps: [],
        waitingOnGates: ["scope-approved"],
      },
      { stepId: "verify", startable: false, waitingOnSteps: ["implement"], waitingOnGates: [] },
      { stepId: "review", startable: false, waitingOnSteps: ["verify"], waitingOnGates: [] },
    ]);
  });

  it("does not treat a failed gate as passed", () => {
    const result = evaluateStepStartability(
      feature,
      steps({ analyze: "succeeded" }),
      gates({ "scope-approved": "failed" }),
    );
    expect(result.find((s) => s.stepId === "implement")?.startable).toBe(false);
  });

  it("starts the step once predecessors succeeded and the gate passed", () => {
    const result = evaluateStepStartability(
      feature,
      steps({ analyze: "succeeded" }),
      gates({ "scope-approved": "passed" }),
    );
    expect(result.find((s) => s.stepId === "implement")?.startable).toBe(true);
  });

  it("does not list steps already running, and does not count a failed predecessor as done", () => {
    const result = evaluateStepStartability(
      feature,
      steps({ analyze: "failed", implement: "running" }),
      gates({ "scope-approved": "passed" }),
    );
    expect(result.map((s) => s.stepId)).toEqual(["verify", "review"]);
  });

  it("lists independent steps together so they can run in parallel", () => {
    const fanOut: WorkflowGraph = {
      steps: [
        { id: "root", needs: [] },
        { id: "left", needs: ["root"] },
        { id: "right", needs: ["root"] },
        { id: "join", needs: ["left", "right"] },
      ],
      gates: [],
    };
    const result = evaluateStepStartability(fanOut, steps({ root: "succeeded" }), gates({}));
    expect(result.filter((s) => s.startable).map((s) => s.stepId)).toEqual(["left", "right"]);
    expect(result.find((s) => s.stepId === "join")?.waitingOnSteps).toEqual(["left", "right"]);
  });
});

describe("evaluateRunCompletion", () => {
  const allDone = steps({
    analyze: "succeeded",
    implement: "succeeded",
    verify: "succeeded",
    review: "succeeded",
  });

  it("completes when all steps succeeded and all gates passed", () => {
    expect(
      evaluateRunCompletion(
        feature,
        allDone,
        gates({ "scope-approved": "passed", "ready-to-merge": "passed" }),
      ),
    ).toEqual([]);
  });

  it("refuses with an open after-gate even if every step succeeded", () => {
    expect(
      evaluateRunCompletion(
        feature,
        allDone,
        gates({ "scope-approved": "passed", "ready-to-merge": "open" }),
      ),
    ).toEqual(["MANDATORY_GATE_NOT_PASSED"]);
  });

  it("reports both reasons when steps and gates are outstanding", () => {
    expect(evaluateRunCompletion(feature, steps({ analyze: "succeeded" }), gates({}))).toEqual([
      "STEPS_NOT_SUCCEEDED",
      "MANDATORY_GATE_NOT_PASSED",
    ]);
  });
});
