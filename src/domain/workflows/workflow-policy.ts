import { findDependencyCycle } from "../shared/graph.js";
import type { StepStatus } from "../runs/step-run.js";

export interface WorkflowStep {
  readonly id: string;
  readonly needs: readonly string[];
}

/** A gate is a runtime condition, not an agent. `before` blocks a step, `after` blocks completion. */
export type WorkflowGate =
  | { readonly id: string; readonly before: string }
  | { readonly id: string; readonly after: string };

export interface WorkflowGraph {
  readonly steps: readonly WorkflowStep[];
  readonly gates: readonly WorkflowGate[];
}

export type WorkflowIssue =
  | { readonly code: "DUPLICATE_STEP"; readonly stepId: string }
  | { readonly code: "DUPLICATE_GATE"; readonly gateId: string }
  | { readonly code: "UNKNOWN_DEPENDENCY"; readonly stepId: string; readonly dependencyId: string }
  | { readonly code: "SELF_DEPENDENCY"; readonly stepId: string }
  | { readonly code: "UNKNOWN_GATE_TARGET"; readonly gateId: string; readonly stepId: string }
  | { readonly code: "DEPENDENCY_CYCLE"; readonly path: readonly string[] };

/**
 * Structural check of one cycle's step graph (architecture.md §6.1). The graph of a cycle must
 * be acyclic: rework loops are the rework controller's job, never an edge back in the DAG.
 * The contract (ADR-0016) already checks unique ids and references; acyclicity lives here.
 */
export function validateWorkflowGraph(graph: WorkflowGraph): readonly WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const stepIds = new Set<string>();
  for (const step of graph.steps) {
    if (stepIds.has(step.id)) issues.push({ code: "DUPLICATE_STEP", stepId: step.id });
    stepIds.add(step.id);
  }
  const edges = new Map<string, readonly string[]>();
  for (const step of graph.steps) {
    const needs: string[] = [];
    for (const dependencyId of step.needs) {
      if (dependencyId === step.id) {
        issues.push({ code: "SELF_DEPENDENCY", stepId: step.id });
      } else if (!stepIds.has(dependencyId)) {
        issues.push({ code: "UNKNOWN_DEPENDENCY", stepId: step.id, dependencyId });
      } else {
        needs.push(dependencyId);
      }
    }
    edges.set(step.id, needs);
  }
  const gateIds = new Set<string>();
  for (const gate of graph.gates) {
    if (gateIds.has(gate.id)) issues.push({ code: "DUPLICATE_GATE", gateId: gate.id });
    gateIds.add(gate.id);
    const target = gateTarget(gate);
    if (!stepIds.has(target)) {
      issues.push({ code: "UNKNOWN_GATE_TARGET", gateId: gate.id, stepId: target });
    }
  }
  const cycle = findDependencyCycle(edges);
  if (cycle !== undefined) issues.push({ code: "DEPENDENCY_CYCLE", path: cycle });
  return issues;
}

function gateTarget(gate: WorkflowGate): string {
  return "before" in gate ? gate.before : gate.after;
}

export type GateStatus = "open" | "passed" | "failed";

export interface StepStartability {
  readonly stepId: string;
  readonly startable: boolean;
  /** Why not: predecessors not succeeded, or a `before` gate not passed. */
  readonly waitingOnSteps: readonly string[];
  readonly waitingOnGates: readonly string[];
}

/**
 * Steps that are `pending`, whose `needs` have all succeeded and whose `before` gates have
 * passed. Independent steps appear together so they can run in parallel (product overview §6.1).
 * A step with a missing status is treated as `pending`.
 */
export function evaluateStepStartability(
  graph: WorkflowGraph,
  stepStatuses: ReadonlyMap<string, StepStatus>,
  gateStatuses: ReadonlyMap<string, GateStatus>,
): readonly StepStartability[] {
  return graph.steps
    .filter((step) => (stepStatuses.get(step.id) ?? "pending") === "pending")
    .map((step) => {
      const waitingOnSteps = step.needs.filter((id) => stepStatuses.get(id) !== "succeeded");
      const waitingOnGates = graph.gates
        .filter((gate) => "before" in gate && gate.before === step.id)
        .filter((gate) => gateStatuses.get(gate.id) !== "passed")
        .map((gate) => gate.id);
      return {
        stepId: step.id,
        startable: waitingOnSteps.length === 0 && waitingOnGates.length === 0,
        waitingOnSteps,
        waitingOnGates,
      };
    });
}

export type CompletionRefusal = "STEPS_NOT_SUCCEEDED" | "MANDATORY_GATE_NOT_PASSED";

/** A run can complete only when every step succeeded and every gate (incl. `after`) passed. */
export function evaluateRunCompletion(
  graph: WorkflowGraph,
  stepStatuses: ReadonlyMap<string, StepStatus>,
  gateStatuses: ReadonlyMap<string, GateStatus>,
): readonly CompletionRefusal[] {
  const refusals: CompletionRefusal[] = [];
  if (graph.steps.some((step) => stepStatuses.get(step.id) !== "succeeded")) {
    refusals.push("STEPS_NOT_SUCCEEDED");
  }
  if (graph.gates.some((gate) => gateStatuses.get(gate.id) !== "passed")) {
    refusals.push("MANDATORY_GATE_NOT_PASSED");
  }
  return refusals;
}
