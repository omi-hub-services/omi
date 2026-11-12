import { acceptanceCriteria } from "./acceptance-criteria.js";
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
  return reasons;
}
