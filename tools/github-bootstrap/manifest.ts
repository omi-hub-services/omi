// Load and validate docs/planning/github-backlog.yaml, cross-checked against
// docs/planning/project-plan.md (§2 milestones, §3 parents, §4 title/role/priority/deps).
// Pure functions: no network. Used by main.ts and the unit tests.
import { parse } from "yaml";

export type IssueType = "epic" | "spike" | "task" | "docs" | "release";
export const WORK_TYPE: Record<IssueType, string> = {
  epic: "Epic",
  spike: "Spike",
  task: "Task",
  docs: "Docs",
  release: "Release",
};

export interface Review {
  checks?: string[];
  reviewers?: string[];
  approval?: string;
}

export interface ManifestIssue {
  key: string;
  title: string;
  type: IssueType;
  parent?: string;
  milestone?: string;
  priority?: string;
  role?: string;
  role_detail?: string;
  area: string;
  workflow?: string;
  blocked_by?: string[];
  objective: string;
  outcome?: string[];
  scope?: { in?: string[]; out?: string[] };
  acceptance_criteria?: string[];
  implementation_map?: string[];
  review?: Review;
}

export interface Field {
  name: string;
  native?: boolean;
  text?: boolean;
  options?: string[];
}

export interface Manifest {
  schema_version: number;
  project: {
    owner: string;
    repository: string;
    title: string;
    default_branch: string;
    integration_branch: string;
  };
  milestones: { key: string; title: string; description: string }[];
  fields: Field[];
  views: { name: string; layout: "board" | "table"; filter: string; fields: string[] }[];
  defaults: { review: Required<Review> };
  issues: ManifestIssue[];
}

export function parseManifest(source: string): Manifest {
  return parse(source, { uniqueKeys: true }) as Manifest;
}

/** Returns one cycle as a list of keys (first === last), or null. */
export function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "visiting") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

export function validateManifest(m: Manifest): string[] {
  const errors: string[] = [];
  const byKey = new Map<string, ManifestIssue>();
  for (const issue of m.issues) {
    if (byKey.has(issue.key)) errors.push(`${issue.key}: duplicate key`);
    byKey.set(issue.key, issue);
  }
  const milestones = new Set(m.milestones.map((x) => x.key));
  const options = new Map(m.fields.map((f) => [f.name, new Set(f.options ?? [])]));
  const checkOption = (issue: ManifestIssue, field: string, value: string | undefined) => {
    if (value !== undefined && !options.get(field)?.has(value)) {
      errors.push(`${issue.key}: ${field} "${value}" is not a Project option`);
    }
  };

  for (const issue of m.issues) {
    const isEpic = issue.type === "epic";
    if (!/^(EP-\d{2}|OMI-\d{3})$/.test(issue.key)) errors.push(`${issue.key}: malformed key`);
    if (!(issue.type in WORK_TYPE)) errors.push(`${issue.key}: unknown type "${issue.type}"`);
    if (isEpic !== issue.key.startsWith("EP-")) errors.push(`${issue.key}: key/type mismatch`);
    if (issue.milestone !== undefined && !milestones.has(issue.milestone)) {
      errors.push(`${issue.key}: unknown milestone ${issue.milestone}`);
    }
    if (!issue.objective) errors.push(`${issue.key}: missing objective`);
    checkOption(issue, "Priority", issue.priority);
    checkOption(issue, "Role", issue.role);
    checkOption(issue, "Area", issue.area);
    checkOption(issue, "Workflow", issue.workflow);
    if (isEpic) {
      if (issue.parent !== undefined) errors.push(`${issue.key}: epics have no parent`);
      if (!issue.outcome?.length) errors.push(`${issue.key}: epic needs an outcome`);
      continue;
    }
    const parent = issue.parent === undefined ? undefined : byKey.get(issue.parent);
    if (parent?.type !== "epic") errors.push(`${issue.key}: parent must be an existing epic`);
    for (const f of ["milestone", "priority", "role", "workflow"] as const) {
      if (issue[f] === undefined) errors.push(`${issue.key}: missing ${f}`);
    }
    if (!issue.scope?.in?.length) errors.push(`${issue.key}: missing scope.in`);
    if (!issue.acceptance_criteria?.length)
      errors.push(`${issue.key}: missing acceptance_criteria`);
    if (!issue.implementation_map?.length) errors.push(`${issue.key}: missing implementation_map`);
    for (const dep of issue.blocked_by ?? []) {
      if (dep === issue.key) errors.push(`${issue.key}: blocked by itself`);
      else if (!byKey.has(dep)) errors.push(`${issue.key}: unknown dependency ${dep}`);
    }
  }

  const cycle = findCycle(new Map(m.issues.map((i) => [i.key, i.blocked_by ?? []])));
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  return errors;
}

const cells = (line: string) =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

function expandKeys(cell: string): string[] {
  const keys: string[] = [];
  for (const token of cell.split(/[;,]/).map((t) => t.trim())) {
    const range = /^OMI-(\d{3})\s*[–-]\s*(?:OMI-)?(\d{3})$/.exec(token);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) {
        keys.push(`OMI-${String(n).padStart(3, "0")}`);
      }
    } else if (/^OMI-\d{3}$/.test(token)) keys.push(token);
  }
  return keys;
}

export interface PlanEntry {
  title: string;
  role?: string;
  priority?: string;
  deps?: string[];
  milestone?: string;
  parent?: string;
}

/** Extracts the per-issue facts that the manifest must reproduce exactly. */
export function parsePlan(markdown: string): Map<string, PlanEntry> {
  const plan = new Map<string, PlanEntry>();
  const entry = (key: string) => {
    let e = plan.get(key);
    if (!e) plan.set(key, (e = { title: "" }));
    return e;
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const c = cells(line);
    const milestone = /^(M\d) — /.exec(c[0] ?? "");
    if (milestone?.[1] && c.length === 3) {
      for (const key of expandKeys(c[1] ?? "")) entry(key).milestone = milestone[1];
      continue;
    }
    const epic = /^(EP-\d{2}) — (.+)$/.exec(c[0] ?? "");
    if (epic?.[1] && epic[2] && c.length === 4) {
      entry(epic[1]).title = epic[2];
      for (const key of expandKeys(c[2] ?? "")) entry(key).parent = epic[1];
      continue;
    }
    if (/^OMI-\d{3}$/.test(c[0] ?? "") && c.length === 4) {
      const [title = "", role, priority] = (c[1] ?? "").split(" — ");
      const e = entry(c[0] ?? "");
      e.title = title;
      if (role !== undefined) e.role = role;
      if (priority !== undefined) e.priority = priority;
      e.deps = c[2] === "Không" ? [] : expandKeys(c[2] ?? "");
    }
  }
  return plan;
}

export function compareWithPlan(m: Manifest, plan: ReadonlyMap<string, PlanEntry>): string[] {
  const errors: string[] = [];
  const keys = new Set(m.issues.map((i) => i.key));
  for (const key of plan.keys())
    if (!keys.has(key)) errors.push(`${key}: in plan but missing from manifest`);
  for (const issue of m.issues) {
    const p = plan.get(issue.key);
    if (!p) {
      errors.push(`${issue.key}: not in project-plan.md`);
      continue;
    }
    const same = (what: string, a: unknown, b: unknown) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        errors.push(`${issue.key}: ${what} ${JSON.stringify(a)} != plan ${JSON.stringify(b)}`);
      }
    };
    same("title", issue.title, p.title);
    if (issue.type === "epic") continue;
    same("milestone", issue.milestone, p.milestone);
    same("parent", issue.parent, p.parent);
    same("role", issue.role_detail ?? issue.role, p.role);
    same("priority", issue.priority, p.priority);
    same("blocked_by", [...(issue.blocked_by ?? [])].sort(), [...(p.deps ?? [])].sort());
  }
  return errors;
}

export interface IssueRef {
  number: number;
  url: string;
}

export const marker = (key: string) => `<!-- omi-squad:plan-key=${key} -->`;
export const MARKER_PATTERN = /<!-- omi-squad:plan-key=((?:EP-\d{2})|(?:OMI-\d{3})) -->/;
export const issueTitle = (i: ManifestIssue) => `[${i.key}] ${i.title}`;

const bullets = (items: readonly string[] | undefined, box = false) =>
  (items ?? []).map((t) => `- ${box ? "[ ] " : ""}${t}`).join("\n");

/** Issue body following project-plan.md §7. `refs` resolves keys to real issues when known. */
export function renderBody(
  m: Manifest,
  issue: ManifestIssue,
  refs: ReadonlyMap<string, IssueRef>,
): string {
  const ref = (key: string) => {
    const r = refs.get(key);
    return r ? `${r.url} (${key})` : `${key} (chưa tạo)`;
  };
  const milestone =
    m.milestones.find((x) => x.key === issue.milestone)?.title ?? "không gán (xem Epic)";
  const plan =
    "Nguồn: `docs/planning/project-plan.md`, manifest `docs/planning/github-backlog.yaml`.";

  if (issue.type === "epic") {
    const children = m.issues.filter((i) => i.parent === issue.key);
    return [
      `## Mục tiêu\n${issue.objective}`,
      `## Outcome (Epic Done khi đạt)\n${bullets(issue.outcome)}\n- Tất cả sub-issue cần thiết Done; không Done chỉ vì checklist được đánh dấu.`,
      `## Sub-issues\n${children.map((c) => `- ${ref(c.key)} — ${c.title}`).join("\n")}\n\nQuan hệ cha–con được gắn bằng native sub-issues.`,
      `## Milestone\n${milestone}`,
      plan,
      marker(issue.key),
    ].join("\n\n");
  }

  const review: Required<Review> = { ...m.defaults.review, ...issue.review };
  const deps = issue.blocked_by ?? [];
  return [
    `## Mục tiêu\n${issue.objective}`,
    `## Phạm vi\n${bullets(issue.scope?.in)}${issue.scope?.out?.length ? `\n\n**Ngoài phạm vi:**\n${bullets(issue.scope.out)}` : ""}`,
    `## Acceptance criteria\n${bullets(issue.acceptance_criteria, true)}`,
    `## Implementation map\n${bullets(issue.implementation_map)}\n- Layer/path theo \`docs/architecture/architecture.md\` §3; quy tắc trong \`AGENTS.md\`.`,
    `## Dependencies\n${deps.length ? deps.map((d) => `- Blocked by: ${ref(d)}`).join("\n") : "- Không"}\n\nQuan hệ được gắn bằng native issue dependencies (blocked by).`,
    [
      "## Workflow và review",
      `- Epic: ${ref(issue.parent ?? "")}`,
      `- Milestone: ${milestone}`,
      `- Workflow: ${issue.workflow ?? ""}`,
      `- Role chính: ${issue.role_detail ?? issue.role ?? ""}`,
      `- Priority: ${issue.priority ?? ""}`,
      `- Required checks: ${review.checks.join("; ")}`,
      `- Review: ${review.reviewers.join("; ")}`,
      `- Approval: ${review.approval}`,
    ].join("\n"),
    "## Evidence\n- PR, test/report, checkpoint hoặc artifact khi có.",
    plan,
    marker(issue.key),
  ].join("\n\n");
}
