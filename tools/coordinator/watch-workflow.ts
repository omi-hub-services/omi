// Workflow-template view of the watch (OMI-088, OMI-092, ADR-0014): the repo reads
// `templates/project/workflows/<id>.yaml` with the runtime's own `workflowSchema` (no second
// parser), maps what it observes (Project Status, worker, PR verdict) to a template position, and
// hands the framework's diagram code the step statuses. Drawing and layout are the framework's
// (src/domain/workflows); nothing here decides how a node looks.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Workflow } from "../../src/application/contracts/workflow.ts";
import type { StepStatus } from "../../src/domain/runs/step-run.ts";
import "../register-ts-imports.ts";
import { clean } from "./watch-core.ts";
import type { Step } from "./watch-tasks.ts";

// dynamic: the register hook above must run before src/ (`.js` specifiers) is resolved
const { orderDiagramNodes } = await import("../../src/domain/workflows/workflow-diagram.ts");

export type TemplateRead =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly reason: string };

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/project/workflows/", import.meta.url));
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Never throws: an unreadable or invalid template becomes `ok: false` with the first line why. */
export async function loadTemplate(
  id: string,
  dir: string = TEMPLATE_DIR,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<TemplateRead> {
  const name = id.trim().toLowerCase();
  if (!WORKFLOW_ID.test(name))
    return { ok: false, reason: `no template for Workflow "${clean(id)}"` };
  try {
    const { workflowSchema } = await import("../../src/application/contracts/workflow.ts");
    const text = await read(`${dir}/${name}.yaml`);
    const parsed = workflowSchema.safeParse(parse(text));
    if (parsed.success) return { ok: true, workflow: parsed.data };
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `template ${name}.yaml invalid: ${issue?.message ?? "schema"}` };
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { ok: false, reason: `template ${name}.yaml not found` };
    }
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    return { ok: false, reason: `template ${name}.yaml unreadable: ${clean(first)}` };
  }
}

/** Developer steps of one workflow run in one worker session, so the last is the one shown. */
export function workStepId(w: Workflow): string {
  const nodes = orderDiagramNodes(w);
  const devs = nodes.filter((n) => n.kind === "step" && n.role === "developer");
  const first = w.gates.find((g) => g.id === "scope-approved")?.before;
  return devs.at(-1)?.id ?? first ?? nodes.find((n) => n.kind === "step")?.id ?? "";
}

export type TemplatePos =
  | { readonly kind: "before" }
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "done" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Pure: where an observed lifecycle step stands in the template. Analyst steps are done once the
 * Issue is Ready (the Coordinator writes the spec); a worker is the developer step; the Coordinator
 * check is the qa step; the review subagent / VERDICT is the reviewer step; PASS is the
 * `ready-to-merge` gate. A workflow with no matching step is `unknown` with the reason. A running
 * worker's own step comes from its prompt header instead (watch-tasks.ts), never from here.
 */
export function mapTemplatePos(w: Workflow, step: Step): TemplatePos {
  const byRole = (role: string): TemplatePos => {
    const found = w.steps.find((s) => s.role === role);
    return found
      ? { kind: "node", id: found.id }
      : { kind: "unknown", reason: `workflow ${w.id} has no ${role} step` };
  };
  switch (step) {
    case "Start":
      return { kind: "before" };
    case "Work":
    case "Rework":
      return { kind: "node", id: workStepId(w) };
    case "Verify/PR":
      return byRole("qa");
    case "Review":
    case "Architect":
      return byRole("reviewer");
    case "Merge":
      return w.gates.some((g) => g.id === "ready-to-merge")
        ? { kind: "node", id: "ready-to-merge" }
        : { kind: "unknown", reason: `workflow ${w.id} has no ready-to-merge gate` };
    case "Done":
      return { kind: "done" };
    default:
      return { kind: "unknown", reason: `step ${step} has no template step` };
  }
}

export interface Standing {
  /** Status of each step the task has reached; a step not reached is absent. */
  readonly steps: ReadonlyMap<string, StepStatus>;
  /** The gate the task stands at, when it stands at a gate and not at a step. */
  readonly atGate?: string;
}

export interface StandingInput {
  readonly workflow: Workflow;
  readonly pos: TemplatePos;
  /** A worker runs at the position. */
  readonly running: boolean;
  /** Coordinator FAIL verdicts so far. */
  readonly fails: number;
  /** The Architect is the next call (review failed, no solution yet). */
  readonly architect: boolean;
}

/**
 * Pure: the step statuses the framework's diagram needs, from where the task stands. Steps before
 * the position are done; the position runs (a worker) or is ready; the review step reads failed
 * while rework is still on its way back to it.
 */
export function standingOf(input: StandingInput): Standing {
  const { workflow, pos } = input;
  const order = orderDiagramNodes(workflow);
  const steps = new Map<string, StepStatus>();
  if (pos.kind === "unknown") return { steps };
  if (pos.kind === "done") {
    for (const node of order) if (node.kind === "step") steps.set(node.id, "succeeded");
    return { steps };
  }
  const devIndex = order.findIndex((node) => node.id === workStepId(workflow));
  const at = pos.kind === "before" ? devIndex : order.findIndex((node) => node.id === pos.id);
  if (at === -1) return { steps };
  order.forEach((node, index) => {
    if (index < at && node.kind === "step") steps.set(node.id, "succeeded");
  });
  const here = order[at];
  let atGate: string | undefined;
  if (pos.kind === "node" && here !== undefined) {
    if (here.kind === "step") steps.set(here.id, input.running ? "running" : "ready");
    else atGate = here.id;
  }
  const reviewer =
    order.filter((node) => node.kind === "step" && node.role === "reviewer").at(-1) ??
    order.filter((node) => node.kind === "step").at(-1);
  if (reviewer !== undefined && (input.architect || (input.fails > 0 && at <= devIndex)))
    steps.set(reviewer.id, "failed");
  return { steps, ...(atGate === undefined ? {} : { atGate }) };
}
