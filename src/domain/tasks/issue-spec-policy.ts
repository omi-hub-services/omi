import { acceptanceCriteria } from "./acceptance-criteria.js";
import { planKeyMarkers } from "./plan-key.js";

const SECTIONS = ["Mục tiêu", "Phạm vi", "Acceptance criteria", "Dependencies"] as const;
const MARKER_OPENING = "<!-- omi-squad:plan-key=";

/** Why the Markdown body of a new-Issue spec cannot become an Issue; empty means acceptable. */
export function issueSpecBodyReasons(body: string, workType: string, prefix: string): string[] {
  const reasons: string[] = [];
  // Headings inside a fenced example are not sections.
  const prose = body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, "");
  const lines = prose.split(/\r?\n/);
  for (const heading of SECTIONS) {
    if (!lines.some((line) => line.trimEnd() === `## ${heading}`))
      reasons.push(`missing ## ${heading}`);
  }
  if (acceptanceCriteria(body).length === 0)
    reasons.push("Acceptance criteria needs at least one top-level checkbox");
  if (workType === "Epic") reasons.push("creating Epics is outside this command's scope");
  const markers = planKeyMarkers(body);
  if (markers.length > 1 || (markers[0] !== undefined && !markers[0].startsWith(`${prefix}-`)))
    reasons.push(`spec may have at most one ${prefix}-NNN marker`);
  if (body.includes(MARKER_OPENING) && markers.length === 0)
    reasons.push("malformed Plan Key marker");
  return reasons;
}
