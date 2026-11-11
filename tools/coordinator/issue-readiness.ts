// Pure Issue data gate, shared by flow decisions and status Attention reporting.
import { MARKER_PATTERN } from "../github-bootstrap/manifest.ts";
import { countAcceptanceCriteria } from "./acceptance-criteria.ts";

export const ISSUE_FIELDS = {
  priority: "Priority",
  workType: "Work Type",
  workflow: "Workflow",
  role: "Role",
  area: "Area",
} as const;

export interface IssueReadiness {
  readonly planKey: string | null;
  readonly body: string;
  readonly priority: string | null;
  readonly workType: string | null;
  readonly workflow: string | null;
  readonly role: string | null;
  readonly area: string | null;
}

export function issueReadinessReasons(issue: IssueReadiness): string[] {
  const reasons: string[] = [];
  if (!issue.planKey?.trim()) reasons.push("missing Plan Key");
  else if (!/^OMI-\d{3}$/.test(issue.planKey)) reasons.push("Plan Key must be OMI-NNN");
  const markers = [...issue.body.matchAll(new RegExp(MARKER_PATTERN.source, "g"))];
  if (markers.length !== 1 || markers[0]?.[1] !== issue.planKey)
    reasons.push("Plan Key must match exactly one body marker");
  for (const [key, name] of Object.entries(ISSUE_FIELDS)) {
    if (!issue[key as keyof typeof ISSUE_FIELDS]?.trim()) reasons.push(`missing ${name}`);
  }
  if (countAcceptanceCriteria(issue.body) === 0)
    reasons.push("Acceptance criteria needs at least one top-level checkbox");
  return reasons;
}
