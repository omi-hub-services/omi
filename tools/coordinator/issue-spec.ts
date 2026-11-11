// Pure spec parsing, Project option validation and Plan Key allocation (no GitHub writes).
import { parse } from "yaml";
import { z } from "zod";
import { marker, MARKER_PATTERN } from "../github-bootstrap/manifest.ts";
import { countAcceptanceCriteria } from "./acceptance-criteria.ts";
import { ISSUE_FIELDS } from "./issue-readiness.ts";

const text = z.string().trim().min(1);
const issueNumber = z.number().int().positive();
const frontmatter = z.strictObject({
  title: text,
  priority: text,
  workType: text,
  workflow: text,
  role: text,
  area: text,
  milestone: text,
  epic: issueNumber,
  blockedBy: z.array(issueNumber),
});
export type IssueSpec = z.infer<typeof frontmatter> & { readonly body: string };
export type SpecResult =
  | { readonly kind: "ok"; readonly spec: IssueSpec }
  | { readonly kind: "refuse"; readonly reason: string };
export interface ProjectField {
  readonly id: string;
  readonly name: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

export function parseIssueSpec(source: string): SpecResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) return { kind: "refuse", reason: "spec requires YAML frontmatter" };
  let raw: unknown;
  try {
    raw = parse(match[1] ?? "", { uniqueKeys: true });
  } catch (error) {
    return { kind: "refuse", reason: `invalid YAML: ${String(error)}` };
  }
  const result = frontmatter.safeParse(raw);
  if (!result.success)
    return {
      kind: "refuse",
      reason: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  const body = (match[2] ?? "").trim();
  const reasons: string[] = [];
  // Ignore fenced examples when looking for real section headings.
  const prose = body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, "");
  for (const heading of ["Mục tiêu", "Phạm vi", "Acceptance criteria", "Dependencies"]) {
    if (!prose.split(/\r?\n/).some((line) => line.trimEnd() === `## ${heading}`))
      reasons.push(`missing ## ${heading}`);
  }
  if (countAcceptanceCriteria(body) === 0)
    reasons.push("Acceptance criteria needs at least one top-level checkbox");
  if (result.data.workType === "Epic") reasons.push("creating Epics is outside new-issue scope");
  const markers = [...body.matchAll(new RegExp(MARKER_PATTERN.source, "g"))];
  if (markers.length > 1 || (markers[0] && !markers[0][1]?.startsWith("OMI-")))
    reasons.push("spec must have at most one OMI-NNN marker");
  if (body.includes("<!-- omi-squad:plan-key=") && markers.length === 0)
    reasons.push("malformed Plan Key marker");
  return reasons.length > 0
    ? { kind: "refuse", reason: reasons.join("; ") }
    : { kind: "ok", spec: { ...result.data, body } };
}

export function validateSpecOptions(spec: IssueSpec, fields: readonly ProjectField[]): string[] {
  return Object.entries({ ...ISSUE_FIELDS, status: "Status" }).flatMap(([key, name]) => {
    const value = key === "status" ? "Backlog" : spec[key as keyof typeof ISSUE_FIELDS];
    return fields.find((f) => f.name === name)?.options.some((o) => o.name === value)
      ? []
      : [`${name} "${value}" is not a Project option`];
  });
}

export function nextPlanKey(keys: readonly (string | null)[]): string {
  const max = keys.reduce((highest, key) => {
    const match = /^OMI-(\d{3})$/.exec(key ?? "");
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  if (max >= 999) throw new Error("OMI-NNN Plan Key space exhausted");
  return `OMI-${String(max + 1).padStart(3, "0")}`;
}

export function issueSpecContent(spec: IssueSpec, key: string) {
  return {
    title: `[${key}] ${spec.title.replace(/^\[OMI-\d{3}\]\s*/, "")}`,
    body: MARKER_PATTERN.test(spec.body) ? spec.body : `${spec.body}\n\n${marker(key)}\n`,
  };
}
