import { acceptanceCriteria } from "./acceptance-criteria.js";
import { implementationPaths } from "./implementation-map.js";
import { PLAN_KEY_PATTERN, planKeyMarkers } from "./plan-key.js";

/** The Project single-select fields every task needs before it can be worked on. */
export const READINESS_FIELDS = {
  priority: "Priority",
  workType: "Work Type",
  workflow: "Workflow",
  role: "Role",
  area: "Area",
} as const;

export interface TaskReadinessInput {
  /** Project `Plan Key` text field. */
  readonly planKey: string | null;
  readonly body: string;
  readonly priority: string | null;
  readonly workType: string | null;
  readonly workflow: string | null;
  readonly role: string | null;
  readonly area: string | null;
}

/**
 * Why a task is not ready to move to Ready / In Progress or to get a branch (ADR-0014): the Plan
 * Key matches exactly one body marker, every Project field is set and at least one top-level
 * acceptance criterion exists. Empty means ready. Criteria are counted by the one authoritative
 * parser, `acceptanceCriteria`.
 */
export function taskReadinessReasons(task: TaskReadinessInput): string[] {
  const reasons: string[] = [];
  const key = task.planKey?.trim() ?? "";
  if (key === "") reasons.push("missing Plan Key");
  else if (!PLAN_KEY_PATTERN.test(key)) reasons.push("Plan Key must look like PREFIX-NNN");
  const markers = planKeyMarkers(task.body);
  if (markers.length !== 1 || markers[0] !== key)
    reasons.push("Plan Key must match exactly one body marker");
  for (const [field, name] of Object.entries(READINESS_FIELDS)) {
    if ((task[field as keyof typeof READINESS_FIELDS]?.trim() ?? "") === "")
      reasons.push(`missing ${name}`);
  }
  if (acceptanceCriteria(task.body).length === 0)
    reasons.push("Acceptance criteria needs at least one top-level checkbox");
  if (task.workType !== "Epic" && implementationPaths(task.body).length === 0)
    reasons.push("Implementation map needs at least one valid relative path");
  reasons.push(...workTypeWorkflowReasons(task.body, task.workType, task.workflow));
  reasons.push(...frameworkCounterpartReasons(task.body, task.area));
  return reasons;
}

/** Shared sync guard: fenced examples cannot supply the required ownership declaration. */
export function frameworkCounterpartReasons(body: string, area: string | null): string[] {
  const prose: string[] = [];
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (
        marker?.[1] !== undefined &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        marker[2]?.trim() === ""
      )
        fence = undefined;
      continue;
    }
    if (marker?.[1] !== undefined) {
      fence = marker[1];
      continue;
    }
    prose.push(line);
  }
  const text = prose.join("\n");
  if (
    area?.trim().toLowerCase() !== "tooling" &&
    !/(?:tools\/coordinator\/|\.claude\/skills\/)/.test(text)
  )
    return [];
  const section = /^## Framework counterpart\s*\n([\s\S]*?)(?=^#{1,2}\s|$(?![\s\S]))/m.exec(
    text,
  )?.[1];
  return section?.replace(/<!--[\s\S]*?-->/g, "").trim()
    ? []
    : ["missing ## Framework counterpart with module/template or reason"];
}

/** Shared intake/readiness invariant; Epic containers do not select a task workflow. */
export function workTypeWorkflowReasons(
  body: string,
  workType: string | null,
  workflow: string | null,
): string[] {
  if (workType === "Epic") return [];
  const reasons: string[] = [];
  if (workType?.trim() && workflow?.trim()) {
    const pairs: Readonly<Record<string, readonly string[]>> = {
      Bug: ["bugfix"],
      Docs: ["docs"],
      Release: ["release", "deploy"],
    };
    const allowed = pairs[workType];
    const owner = Object.entries(pairs).find(([, workflows]) => workflows.includes(workflow))?.[0];
    if ((allowed && !allowed.includes(workflow)) || (owner && owner !== workType))
      reasons.push(
        `Work Type "${workType}" does not match Workflow "${workflow}"; use Bug/bugfix, Docs/docs, Release/release|deploy`,
      );
  }
  let fence: string | undefined;
  let inSection = false;
  let found = false;
  const evidence: string[] = [];
  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (
        marker?.[1] !== undefined &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        marker[2]?.trim() === ""
      )
        fence = undefined;
      else if (inSection) evidence.push(line);
      continue;
    }
    if (marker?.[1] !== undefined) {
      fence = marker[1];
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      inSection = line.trimEnd() === "## Tái hiện";
      found ||= inSection;
    } else if (inSection) evidence.push(line);
  }
  if (workType === "Bug" && (!found || !evidence.join("\n").trim()))
    reasons.push("Bug requires non-empty ## Tái hiện");
  if (workType === "Task" && found)
    reasons.push("Task has ## Tái hiện; use Work Type Bug and Workflow bugfix");
  return reasons;
}
