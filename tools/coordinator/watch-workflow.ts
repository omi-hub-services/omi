// Workflow-template view of the watch (OMI-088, ADR-0014): the diagram is drawn from the steps and
// gates of `templates/project/workflows/<id>.yaml`, parsed with the runtime's own `workflowSchema`
// (no second parser). Everything except `loadTemplate` is pure.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Workflow } from "../../src/application/contracts/workflow.ts";
import "../register-ts-imports.ts";
import { clean } from "./watch-core.ts";
import {
  extraNodes,
  type CyclePhase,
  type DiagramNode,
  type NodeState,
  type Step,
} from "./watch-tasks.ts";

export type TemplateRead =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly reason: string };

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/project/workflows/", import.meta.url));
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Never throws: an unreadable or invalid template becomes `ok: false` with the first line why. */
export async function loadTemplate(id: string, dir: string = TEMPLATE_DIR): Promise<TemplateRead> {
  const name = id.trim().toLowerCase();
  if (!WORKFLOW_ID.test(name))
    return { ok: false, reason: `no template for Workflow "${clean(id)}"` };
  try {
    // dynamic: the register hook above must run before src/ (`.js` specifiers) is resolved
    const { workflowSchema } = await import("../../src/application/contracts/workflow.ts");
    const text = await readFile(`${dir}/${name}.yaml`, "utf8");
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

export interface TemplateNode {
  readonly id: string;
  readonly kind: "step" | "gate";
  readonly role?: string;
  readonly skills: readonly string[];
  readonly rules: readonly string[];
}

/** Steps ordered by `needs` (stable, file order among equals); each gate sits before/after its step. */
export function orderNodes(w: Workflow): TemplateNode[] {
  const left = [...w.steps];
  const done = new Set<string>();
  const out: TemplateNode[] = [];
  const gates = (key: "before" | "after", step: string) =>
    w.gates
      .filter((g) => g[key] === step)
      .map((g): TemplateNode => ({ id: g.id, kind: "gate", skills: [], rules: [] }));
  while (left.length > 0) {
    const i = left.findIndex((s) => s.needs.every((n) => done.has(n)));
    const [s] = left.splice(i === -1 ? 0 : i, 1); // a cycle falls back to file order
    if (!s) break;
    done.add(s.id);
    out.push(
      ...gates("before", s.id),
      { id: s.id, kind: "step", role: s.role, skills: s.skills, rules: s.rules },
      ...gates("after", s.id),
    );
  }
  return out;
}

/** Developer steps of one workflow run in one worker session, so the last is the one shown. */
export function workStepId(w: Workflow): string {
  const devs = orderNodes(w).filter((n) => n.kind === "step" && n.role === "developer");
  const first = w.gates.find((g) => g.id === "scope-approved")?.before;
  return devs.at(-1)?.id ?? first ?? orderNodes(w).find((n) => n.kind === "step")?.id ?? "";
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
 * `ready-to-merge` gate. A workflow with no matching step is `unknown` with the reason.
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

/**
 * Pure: the template diagram's nodes, then the Architect / Ask PO extras of the cycle. `holdSub`
 * draws the node the task stands at as blocked; `reworkSub` labels the work step; `architectStep`
 * makes the reviewer step done and Architect current.
 */
export function templateNodes(
  w: Workflow,
  pos: TemplatePos,
  cycle: CyclePhase,
  holdSub?: string,
  reworkSub?: string,
  architectStep = false,
): DiagramNode[] {
  const order = orderNodes(w);
  const work = order.findIndex((n) => n.id === workStepId(w));
  const at =
    pos.kind === "before"
      ? work
      : pos.kind === "node"
        ? order.findIndex((n) => n.id === pos.id)
        : -1;
  const main = order.map((n, i): DiagramNode => {
    let state: NodeState = "todo";
    if (pos.kind === "done" || (at !== -1 && i < at)) state = "done";
    else if (at !== -1 && i === at && pos.kind !== "before") {
      state = architectStep ? "done" : "current";
    }
    let sub = n.role;
    if (i === at && pos.kind === "node") {
      if (holdSub !== undefined) {
        state = "blocked";
        sub = holdSub;
      } else if (reworkSub !== undefined && n.id === workStepId(w)) sub = reworkSub;
    }
    return {
      id: n.id,
      label: n.id,
      state,
      sub: sub ?? "gate",
      kind: n.kind,
      ...(n.role === undefined ? {} : { role: n.role }),
      skills: n.skills,
      rules: n.rules,
    };
  });
  return [...main, ...extraNodes(architectStep ? "Architect" : "Work", cycle)];
}

export interface SkillCheck {
  /** Skills the template gives the current step. */
  readonly expected: readonly string[];
  /** In the template step but not loaded into the prompt. */
  readonly missing: readonly string[];
  /** Loaded but not in the template step; `template` is the step that does list it, or null. */
  readonly extra: readonly { readonly name: string; readonly template: string | null }[];
}

/** Pure: loaded skills against the template step's skills; null when `stepId` is not a step. */
export function compareLoaded(
  w: Workflow,
  stepId: string,
  loaded: readonly string[],
): SkillCheck | null {
  const step = w.steps.find((s) => s.id === stepId);
  if (!step) return null;
  return {
    expected: step.skills,
    missing: step.skills.filter((s) => !loaded.includes(s)),
    extra: loaded
      .filter((s) => !step.skills.includes(s))
      .map((name) => ({
        name,
        template: w.steps.find((o) => o.skills.includes(name))?.id ?? null,
      })),
  };
}
