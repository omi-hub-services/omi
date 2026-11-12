// Pure spec parsing, Project option validation and Plan Key allocation (no GitHub writes).
import { parse } from "yaml";
import { z } from "zod";
import { marker, MARKER_PATTERN } from "../github-bootstrap/manifest.ts";
import "../register-ts-imports.ts";
const { issueSpecBodyReasons } = await import("../../src/domain/tasks/issue-spec-policy.ts");
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
  const reasons = issueSpecBodyReasons(body, result.data.workType, "OMI", result.data.area);
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
