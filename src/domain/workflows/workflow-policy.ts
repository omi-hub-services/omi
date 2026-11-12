import { findDependencyCycle } from "../shared/graph.js";
import type { StepStatus } from "../runs/step-run.js";
import {
  resolveTaskEffort,
  type Complexity,
  type EffortInput,
} from "../agents/complexity-policy.js";
import { effortRank } from "../agents/capability.js";
import type { Effort } from "../agents/capability.js";

export interface QualityPolicyInput {
  readonly qualityPolicy: string;
  readonly complexity: Complexity;
  readonly step: string;
  readonly round: number;
  readonly developerEffort?: Effort;
  readonly risks: { readonly security: boolean; readonly gates: boolean; readonly data: boolean };
  /** An explicit runtime decision, never a SCOPE-APPROVED string parsed from prose. */
  readonly scope?:
    | {
        readonly measurableAc: boolean;
        readonly implementationMap: boolean;
        readonly issueRef: string;
        readonly approvalRef: string;
      }
    | undefined;
}

/** Broad source scopes are unknown risk; explicit files can qualify for the cheaper plan. */
export function workflowRisks(
  paths: readonly string[],
  area?: string | null,
): QualityPolicyInput["risks"] {
  const broad =
    paths.length === 0 ||
    paths.some((p) => /^(?:src(?:\/(?:domain|application|infrastructure))?|\.)\/?$/.test(p));
  return {
    security:
      broad || area === "security" || paths.some((p) => /security|auth|credential|secret/i.test(p)),
    gates: broad || paths.some((p) => /approval|gate|delivery|workflow|rules|coordinator/i.test(p)),
    data: broad || paths.some((p) => /migration|persist|database|sqlite|data\//i.test(p)),
  };
}

/** Cost choices cannot turn off delivery requirements. Unknown policies fail closed. */
export function resolveQualityPolicy(input: QualityPolicyInput) {
  const qualityStep = input.step === "verify" || input.step === "review";
  const skipAnalyze = Boolean(
    input.scope?.measurableAc &&
    input.scope.implementationMap &&
    input.scope.issueRef.trim() &&
    input.scope.approvalRef.trim(),
  );
  const effort: Effort =
    input.step === "analyze" || (input.step === "review" && input.round === 1)
      ? "medium"
      : qualityStep
        ? "low"
        : (input.developerEffort ?? input.complexity);
  return {
    combineVerifyReview:
      ["task-default", "lean"].includes(input.qualityPolicy) &&
      input.complexity !== "high" &&
      !Object.values(input.risks).some(Boolean),
    skipAnalyze,
    scopeEvidence: skipAnalyze ? input.scope?.issueRef : undefined,
    effort,
    reviewScope: qualityStep && input.round > 1 ? "delta-with-previous-verdict" : "full",
    independentReview: true as const,
    exactShaCheck: true as const,
  };
}

/** The same floor is checked by selection and again at dispatch. */
export function resolveWorkflowEffort(
  task: EffortInput,
  mapping: Readonly<Record<Complexity, Effort>>,
  floor: Effort,
  quality?: { readonly policy: string; readonly step: string; readonly round: number },
) {
  const taskDecision = resolveTaskEffort(task, mapping, floor);
  if (quality === undefined) return taskDecision;
  const decision = resolveQualityPolicy({
    qualityPolicy: quality.policy,
    complexity: taskDecision.complexity,
    step: quality.step,
    round: quality.round,
    developerEffort: mapping[taskDecision.complexity],
    risks: { security: false, gates: false, data: false },
  });
  const minEffort = effortRank(floor) > effortRank(decision.effort) ? floor : decision.effort;
  return {
    ...taskDecision,
    minEffort,
    reason: `${taskDecision.reason}; step ${quality.step} round ${String(quality.round)} policy ${quality.policy}; minimum ${minEffort}`,
  };
}

/** Legacy Project values have explicit routes; release/deploy never become ungated workers. */
export function resolveWorkflowRoute(id: string): {
  readonly kind: "template" | "delivery";
  readonly id: string;
} {
  if (id === "release") return { kind: "delivery", id: "prepare-release" };
  if (id === "deploy") return { kind: "delivery", id: "deploy-release" };
  return {
    kind: "template",
    id: id === "init" ? "onboarding-takeover" : id === "research" ? "idea-to-issues" : id,
  };
}

export function workflowOptionIssues(
  options: readonly string[],
  templateIds: readonly string[],
): readonly string[] {
  return options.flatMap((option) => {
    const route = resolveWorkflowRoute(option);
    return route.kind === "template" && !templateIds.includes(route.id)
      ? [`${option}: missing template ${route.id}`]
      : [];
  });
}

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
