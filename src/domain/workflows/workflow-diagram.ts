import { resumeSkills } from "./workflow-policy.js";
import type { ReworkCycle } from "../runs/rework-cycle.js";
import type { StepStatus } from "../runs/step-run.js";

/**
 * The lifecycle diagram of one task, drawn from its workflow template and the runtime's own step
 * states. Pure: the template, the step statuses and the rework controller view come in;
 * nothing here reads comments, files or the clock. The Workflow contract fits `DiagramWorkflow`
 * structurally, so the domain does not import it.
 */
export interface DiagramWorkflow {
  readonly id: string;
  readonly steps: readonly {
    readonly id: string;
    readonly role: string;
    readonly needs: readonly string[];
    readonly skills: readonly string[];
    readonly rules: readonly string[];
  }[];
  readonly gates: readonly {
    readonly id: string;
    readonly before?: string | undefined;
    readonly after?: string | undefined;
  }[];
}

export interface TemplateNode {
  readonly id: string;
  readonly kind: "step" | "gate";
  readonly role?: string;
  readonly skills: readonly string[];
  readonly rules: readonly string[];
}

/** Steps ordered by `needs` (stable, file order among equals); each gate sits before/after its step. */
export function orderDiagramNodes(workflow: DiagramWorkflow): TemplateNode[] {
  const left = [...workflow.steps];
  const placed = new Set<string>();
  const out: TemplateNode[] = [];
  const gates = (key: "before" | "after", step: string): TemplateNode[] =>
    workflow.gates
      .filter((gate) => gate[key] === step)
      .map((gate) => ({ id: gate.id, kind: "gate", skills: [], rules: [] }));
  while (left.length > 0) {
    const index = left.findIndex((step) => step.needs.every((need) => placed.has(need)));
    const [step] = left.splice(index === -1 ? 0 : index, 1); // a cycle falls back to file order
    if (step === undefined) break;
    placed.add(step.id);
    out.push(
      ...gates("before", step.id),
      { id: step.id, kind: "step", role: step.role, skills: step.skills, rules: step.rules },
      ...gates("after", step.id),
    );
  }
  return out;
}

export type NodeState =
  "done" | "current" | "todo" | "blocked" | "waiting-po" | "failed" | "skipped";

export interface DiagramNode {
  readonly id: string;
  readonly kind: "step" | "gate" | "architect" | "ask-po";
  readonly label: string;
  readonly state: NodeState;
  /** Short second line: role, or why the node is held. */
  readonly sub: string;
  readonly role?: string;
  readonly skills: readonly string[];
  readonly rules: readonly string[];
}

/** A task that cannot move although no worker runs: open blockers, or a decision only the PO makes. */
export type Hold =
  { readonly kind: "blocked"; readonly by: readonly number[] } | { readonly kind: "waiting-po" };

export interface WorkflowDiagram {
  readonly nodes: readonly DiagramNode[];
  /** The loop back from the reviewer step to the developer step; absent before the first failure. */
  readonly reworkEdge?: { readonly from: string; readonly to: string; readonly failures: number };
}

export interface DiagramInput {
  readonly workflow: DiagramWorkflow;
  /** Latest status of each step id; a step with no run yet is absent. */
  readonly steps: ReadonlyMap<string, StepStatus>;
  readonly cycle: ReworkCycle;
  /** Failed quality cycles counted so far, across the Architect. */
  readonly failures: number;
  readonly hold?: Hold;
  /** The gate (not a step) the task stands at: drawn current, or held when `hold` is set. */
  readonly atGate?: string;
}

const CURRENT: readonly StepStatus[] = [
  "running",
  "ready",
  "waiting_approval",
  "waiting_resource",
  "paused",
  "interrupted",
];
/** A step in one of these has passed the gate that sits before it. */
const PAST_BEFORE_GATE: readonly StepStatus[] = [
  "running",
  "succeeded",
  "failed",
  "waiting_resource",
  "paused",
  "interrupted",
];
const STATUS_LABEL: Partial<Record<StepStatus, string>> = {
  waiting_approval: "waiting approval",
  waiting_resource: "waiting resource",
  paused: "paused",
  interrupted: "interrupted",
  failed: "failed",
};

function stepState(status: StepStatus | undefined): NodeState {
  if (status === "succeeded") return "done";
  if (status === "failed") return "failed";
  return status !== undefined && CURRENT.includes(status) ? "current" : "todo";
}

const holdLabel = (hold: Hold): string =>
  hold.kind === "waiting-po"
    ? "waiting PO"
    : hold.by.length === 0
      ? "blocked"
      : `blocked by #${String(hold.by[0] ?? "?")}${hold.by.length > 1 ? ` +${String(hold.by.length - 1)}` : ""}`;

export function buildWorkflowDiagram(input: DiagramInput): WorkflowDiagram {
  const { workflow, steps, cycle, hold } = input;
  const order = orderDiagramNodes(workflow);
  const stepNodes = order.filter((node) => node.kind === "step");
  const developer = stepNodes.filter((node) => node.role === "developer").at(-1) ?? stepNodes[0];
  const reviewer = stepNodes.filter((node) => node.role === "reviewer").at(-1) ?? stepNodes.at(-1);

  const gateState = (id: string): NodeState => {
    const gate = workflow.gates.find((candidate) => candidate.id === id);
    if (gate?.before !== undefined) {
      const status = steps.get(gate.before);
      return status !== undefined && PAST_BEFORE_GATE.includes(status) ? "done" : "todo";
    }
    return gate?.after !== undefined && steps.get(gate.after) === "succeeded" ? "done" : "todo";
  };
  const states = new Map(
    order.map((node) => [
      node.id,
      node.kind === "gate" ? gateState(node.id) : stepState(steps.get(node.id)),
    ]),
  );
  // The held node is where the task stands: the step in progress, else the next one to run.
  const gateAt = order.find((node) => node.kind === "gate" && node.id === input.atGate)?.id;
  const heldId =
    hold === undefined
      ? undefined
      : (gateAt ??
        stepNodes.find((node) => ["current", "failed"].includes(states.get(node.id) ?? ""))?.id ??
        stepNodes.find((node) => states.get(node.id) === "todo")?.id);

  const nodes: DiagramNode[] = order.map((node) => {
    let state = states.get(node.id) ?? "todo";
    let sub = node.role ?? "gate";
    const status = steps.get(node.id);
    if (hold !== undefined && node.id === heldId) {
      state = hold.kind;
      sub = holdLabel(hold);
    } else if (node.id === gateAt) {
      state = "current";
      sub = "waiting";
    } else if (node.kind === "step" && status !== undefined && STATUS_LABEL[status] !== undefined) {
      sub = STATUS_LABEL[status];
    } else if (state === "current" && node.id === developer?.id && cycle.rework > 0) {
      if (cycle.phase === "before-architect")
        sub = `rework ${String(cycle.rework)}/${String(cycle.of)}`;
      else if (cycle.phase === "after-architect")
        sub = `rework ${String(cycle.rework)}/${String(cycle.of)} (after Architect)`;
    }
    return {
      id: node.id,
      kind: node.kind,
      label: node.id,
      state,
      sub,
      ...(node.role === undefined ? {} : { role: node.role }),
      skills: node.skills,
      rules: node.rules,
    };
  });

  const extras: DiagramNode[] = [];
  if (cycle.architect !== "none") {
    const [state, sub] =
      cycle.architect === "needed"
        ? (["current", "needs a call"] as const)
        : cycle.architect === "called"
          ? (["done", "called"] as const)
          : (["failed", "no solution"] as const);
    extras.push({
      id: "architect",
      kind: "architect",
      label: "architect",
      state,
      sub,
      role: "architect",
      skills: [],
      rules: [],
    });
  }
  if (cycle.phase === "escalate-po") {
    extras.push({
      id: "ask-po",
      kind: "ask-po",
      label: "ask-po",
      state: "waiting-po",
      sub: "PO decides",
      skills: [],
      rules: [],
    });
  }

  return {
    nodes: [...nodes, ...extras],
    ...(input.failures > 0 && developer !== undefined && reviewer !== undefined
      ? { reworkEdge: { from: reviewer.id, to: developer.id, failures: input.failures } }
      : {}),
  };
}

export interface SkillCheck {
  /** Skills the template gives the step. */
  readonly expected: readonly string[];
  /** In the template step but not loaded into the worker's context. */
  readonly missing: readonly string[];
  /** Loaded but not in the template step; `template` is the step that does list it, or null. */
  readonly extra: readonly { readonly name: string; readonly template: string | null }[];
}

/** The skills a worker really loaded against the template step's; undefined when `stepId` is no step. */
export function compareLoadedSkills(
  workflow: DiagramWorkflow,
  stepId: string,
  loaded: readonly string[],
): SkillCheck | undefined {
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) return undefined;
  return {
    expected: step.skills,
    missing: step.skills.filter((skill) => !loaded.includes(skill)),
    // A native-resume packet carries resumeSkills(step.skills); those are expected, not extra.
    extra: loaded
      .filter((skill) => !resumeSkills(step.skills).includes(skill))
      .map((name) => ({
        name,
        template: workflow.steps.find((other) => other.skills.includes(name))?.id ?? null,
      })),
  };
}
