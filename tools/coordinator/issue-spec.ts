// Pure spec parsing, Project option validation and Plan Key allocation (no GitHub writes).
import { z } from "zod";
import { marker, MARKER_PATTERN } from "../github-bootstrap/manifest.ts";
import "../register-ts-imports.ts";
const { splitIssueSpec } =
  await import("../../src/infrastructure/config/issue-spec-frontmatter.ts");
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
const epicFrontmatter = z.strictObject({
  title: text,
  workType: z.literal("Epic"),
  area: text,
  milestone: text,
  status: text,
});
export type IssueSpec = (z.infer<typeof frontmatter> | z.infer<typeof epicFrontmatter>) & {
  readonly body: string;
};
export type SpecResult =
  | { readonly kind: "ok"; readonly spec: IssueSpec }
  | { readonly kind: "refuse"; readonly reason: string };
export interface ProjectField {
  readonly id: string;
  readonly name: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

export function parseIssueSpec(source: string, epic = false): SpecResult {
  const split = splitIssueSpec(source);
  if (split.kind === "invalid") return { kind: "refuse", reason: split.reason };
  const raw = split.frontmatter;
  const result = (epic ? epicFrontmatter : frontmatter).safeParse(raw);
  if (!result.success)
    return {
      kind: "refuse",
      reason: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  const body = split.body.trim();
  const reasons = epic
    ? (!body ? ["Epic body must not be empty"] : []).concat(
        (body.match(/<!--\s*omi-squad:plan-key=/g)?.length ?? 0) > 1 ||
          (body.includes("omi-squad:plan-key=") &&
            !/^EP-\d{2}$/.test(MARKER_PATTERN.exec(body)?.[1] ?? ""))
          ? ["Epic spec may have at most one EP-nn marker"]
          : [],
      )
    : issueSpecBodyReasons(
        body,
        result.data.workType,
        "OMI",
        result.data.area,
        "workflow" in result.data ? result.data.workflow : null,
      );
  return reasons.length > 0
    ? { kind: "refuse", reason: reasons.join("; ") }
    : { kind: "ok", spec: { ...result.data, body } };
}

export function specProjectValues(spec: IssueSpec): Record<string, string> {
  return "epic" in spec
    ? {
        ...Object.fromEntries(
          Object.entries(ISSUE_FIELDS).map(([key, name]) => [
            name,
            spec[key as keyof typeof ISSUE_FIELDS],
          ]),
        ),
        Status: "Backlog",
      }
    : { "Work Type": "Epic", Area: spec.area, Status: spec.status };
}

export function validateSpecOptions(spec: IssueSpec, fields: readonly ProjectField[]): string[] {
  return Object.entries(specProjectValues(spec)).flatMap(([name, value]) =>
    fields.find((f) => f.name === name)?.options.some((o) => o.name === value)
      ? []
      : [`${name} "${value}" is not a Project option`],
  );
}

export function nextEpicPlanKey(keys: readonly (string | null)[]): string {
  const highest = keys.reduce((max, key) => {
    const match = /^EP-(\d{2})$/.exec(key ?? "");
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  if (highest >= 99) throw new Error("EP-nn Plan Key space exhausted");
  return `EP-${String(highest + 1).padStart(2, "0")}`;
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
    title: `[${key}] ${spec.title.replace(/^\[(?:OMI-\d{3}|EP-\d{2})\]\s*/, "")}`,
    body: MARKER_PATTERN.test(spec.body) ? spec.body : `${spec.body}\n\n${marker(key)}\n`,
  };
}
