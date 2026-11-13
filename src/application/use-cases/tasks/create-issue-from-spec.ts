import { issueSpecBodyReasons } from "../../../domain/tasks/issue-spec-policy.js";
import { nextPlanKey, planKeyMarker, planKeyMarkers } from "../../../domain/tasks/plan-key.js";
import { READINESS_FIELDS } from "../../../domain/tasks/readiness-gate.js";
import {
  createIssueFromSpecSchema,
  issueSpecFrontmatterSchema,
} from "../../contracts/task-intake.js";
import type { IssueSpecFrontmatter } from "../../contracts/task-intake.js";
import type { FieldWrite, GithubIntake, IntakeSnapshot } from "../../ports/github-intake.js";
import type { IssueSpecFile } from "../../ports/issue-spec-file.js";

export interface IssuePlan {
  readonly planKey: string;
  readonly title: string;
  readonly body: string;
  /** Project field name → value, `Status` and `Plan Key` included. */
  readonly fields: Readonly<Record<string, string>>;
  readonly milestone: string;
  readonly epic: number;
  readonly blockedBy: readonly number[];
}

export type CreateIssueResult =
  | { readonly kind: "refused"; readonly reasons: readonly string[] }
  /** The spec's saved marker already belongs to an Issue; nothing was written. */
  | { readonly kind: "exists"; readonly planKey: string; readonly issueNumber: number }
  | { readonly kind: "preview"; readonly plan: IssuePlan }
  | { readonly kind: "created"; readonly plan: IssuePlan; readonly issueNumber: number };

const SINGLE_SELECTS = ["Status", ...Object.values(READINESS_FIELDS)];

/** Field values in the order they are written; `Status` starts every task in Backlog. */
function fieldValues(spec: IssueSpecFrontmatter, planKey: string): Record<string, string> {
  return {
    Priority: spec.priority,
    "Work Type": spec.workType,
    Workflow: spec.workflow,
    Role: spec.role,
    Area: spec.area,
    Status: "Backlog",
    "Plan Key": planKey,
  };
}

function optionReasons(values: Record<string, string>, data: IntakeSnapshot): string[] {
  const reasons: string[] = [];
  for (const name of SINGLE_SELECTS) {
    const field = data.fields.find((f) => f.name === name);
    if (!field?.options.some((o) => o.name === values[name]))
      reasons.push(`${name} "${values[name] ?? ""}" is not a Project option`);
  }
  if (!data.fields.some((f) => f.name === "Plan Key" && f.dataType === "TEXT"))
    reasons.push("Project needs a Plan Key text field");
  return reasons;
}

/**
 * Creates one task Issue from a Markdown spec with YAML frontmatter (ADR-0014). Without `apply`
 * it only previews. A real run saves the allocated marker into the spec file before the first
 * remote write, so a retry finds the Issue (or reuses the key) instead of allocating another.
 * Refusals are returned with every reason and nothing is written; a remote failure propagates.
 */
export async function createIssueFromSpec(
  deps: { readonly spec: IssueSpecFile; readonly intake: GithubIntake },
  input: unknown,
): Promise<CreateIssueResult> {
  const request = createIssueFromSpecSchema.parse(input);
  const refuse = (...reasons: string[]): CreateIssueResult => ({ kind: "refused", reasons });

  const read = await deps.spec.read();
  if (read.kind === "invalid") return refuse(read.reason);
  const parsed = issueSpecFrontmatterSchema.safeParse(read.frontmatter);
  if (!parsed.success)
    return refuse(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const spec = parsed.data;
  const body = read.body.trim();
  const bodyReasons = issueSpecBodyReasons(
    body,
    spec.workType,
    request.prefix,
    spec.area,
    spec.workflow,
  );
  if (bodyReasons.length > 0) return refuse(...bodyReasons);

  const data = await deps.intake.snapshot();
  const requested = planKeyMarkers(body)[0];
  const reasons = optionReasons(fieldValues(spec, requested ?? ""), data);
  const milestone = data.milestones.find((m) => m.title === spec.milestone);
  if (milestone === undefined) reasons.push(`unknown milestone "${spec.milestone}"`);
  if (reasons.length > 0 || milestone === undefined) return refuse(...reasons);

  const existing =
    requested === undefined
      ? undefined
      : data.issues.find((issue) => planKeyMarkers(issue.body)[0] === requested);
  if (requested !== undefined && existing !== undefined)
    return { kind: "exists", planKey: requested, issueNumber: existing.number };

  const allocated = [
    ...data.issues.flatMap((i) => [
      planKeyMarkers(i.body)[0] ?? null,
      /^\[([A-Z][A-Z0-9]*-\d{3})\]/.exec(i.title)?.[1] ?? null,
    ]),
    ...data.projectPlanKeys,
  ];
  if (requested !== undefined && allocated.includes(requested))
    return refuse(`${requested} is already allocated without a matching marker`);
  const planKey = requested ?? nextPlanKey(request.prefix, allocated);

  // Resolve every reference before the first write: no half-created Issue from a bad spec.
  const references = new Map<number, number>();
  for (const number of new Set([spec.epic, ...spec.blockedBy])) {
    const issue = data.issues.find((i) => i.number === number);
    if (issue === undefined) reasons.push(`Issue #${String(number)} not found`);
    else references.set(number, issue.id);
  }
  const epic = data.issues.find((i) => i.number === spec.epic);
  if (epic !== undefined && !planKeyMarkers(epic.body)[0]?.startsWith("EP-"))
    reasons.push(`Issue #${String(spec.epic)} is not an Epic with a Plan Key marker`);
  if (reasons.length > 0) return refuse(...reasons);

  const title = `[${planKey}] ${spec.title.replace(/^\[[A-Z][A-Z0-9]*-\d{3}\]\s*/, "")}`;
  const plan: IssuePlan = {
    planKey,
    title,
    body: requested === undefined ? `${body}\n\n${planKeyMarker(planKey)}\n` : body,
    fields: fieldValues(spec, planKey),
    milestone: spec.milestone,
    epic: spec.epic,
    blockedBy: spec.blockedBy,
  };
  if (!request.apply) return { kind: "preview", plan };

  if (requested === undefined) await deps.spec.recordPlanKeyMarker(planKeyMarker(planKey));
  const fields: FieldWrite[] = Object.entries(plan.fields).flatMap(
    ([name, value]): FieldWrite[] => {
      const field = data.fields.find((f) => f.name === name);
      if (field === undefined) return [];
      if (name === "Plan Key") return [{ fieldId: field.id, name, text: value }];
      const option = field.options.find((o) => o.name === value);
      return option === undefined ? [] : [{ fieldId: field.id, name, optionId: option.id }];
    },
  );
  const created = await deps.intake.createTask({
    title: plan.title,
    body: plan.body,
    milestoneNumber: milestone.number,
    projectId: data.projectId,
    fields,
    epic: { number: spec.epic, id: references.get(spec.epic) ?? 0 },
    blockedBy: [...new Set(spec.blockedBy)].map((number) => ({
      number,
      id: references.get(number) ?? 0,
    })),
  });
  return { kind: "created", plan, issueNumber: created.number };
}
