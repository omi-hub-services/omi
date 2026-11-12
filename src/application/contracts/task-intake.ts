import { z } from "zod";

const text = z.string().trim().min(1).max(1000);
const issueNumber = z.number().int().positive();

/** YAML frontmatter of an Issue spec (ADR-0014). Every key is required; unknown keys are errors. */
export const issueSpecFrontmatterSchema = z.strictObject({
  title: text,
  priority: text,
  workType: text,
  workflow: text,
  role: text,
  area: text,
  /** Exact GitHub milestone title. */
  milestone: text,
  /** Number of an existing Epic Issue; creating Epics is out of scope. */
  epic: issueNumber,
  blockedBy: z.array(issueNumber).max(100),
});
export type IssueSpecFrontmatter = z.infer<typeof issueSpecFrontmatterSchema>;

/** Prefix of the project's task keys, e.g. `OMI` for `OMI-079`. */
export const planKeyPrefixSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/);

export const createIssueFromSpecSchema = z.strictObject({
  prefix: planKeyPrefixSchema,
  /** Without it the use case only previews. */
  apply: z.boolean(),
});

export const promoteTaskSchema = z.strictObject({
  /** Absent: promote the first eligible Backlog Issue. */
  issueNumber: issueNumber.optional(),
  dryRun: z.boolean(),
});

/** The only statuses this command sets; both need the readiness gate. */
export const GATED_STATUSES = ["Ready", "In Progress"] as const;
export const setTaskStatusSchema = z.strictObject({
  issueNumber,
  status: z.enum(GATED_STATUSES),
});
export type GatedStatus = (typeof GATED_STATUSES)[number];
