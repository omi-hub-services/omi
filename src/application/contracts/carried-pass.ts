import { z } from "zod";
import { checkRunRecordSchema } from "./check-run.js";
import { artifactPathSchema } from "./artifact.js";
import { gitShaSchema, identifierSchema, slugSchema } from "./identifiers.js";

/** One request to carry a task's PASS over a sync of its branch with the integration branch. */
export const carryPassSchema = z.strictObject({
  projectId: identifierSchema,
  taskId: identifierSchema,
  /** The task's worktree; its branch is the PR head. */
  worktreePath: z.string().min(1),
  /** Checks re-run on the new head; each must have a runtime command. */
  requiredChecks: z.array(slugSchema).min(1).max(50),
  /** Existing attempt of the task that anchors the evidence artifacts, and its artifact prefix. */
  attemptId: identifierSchema,
  artifactRoot: artifactPathSchema,
});
export type CarryPassRequest = z.infer<typeof carryPassSchema>;

/** The evidence stored for a carried PASS: old head, new head and the automatic merge tree. */
export const carriedPassRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: identifierSchema,
  oldHeadSha: gitShaSchema,
  newHeadSha: gitShaSchema,
  baseCommit: gitShaSchema,
  mergeTree: gitShaSchema,
  checks: z.array(
    checkRunRecordSchema.pick({ checkId: true, status: true, revision: true, evidence: true }),
  ),
  recordedAt: z.iso.datetime({ precision: 3 }),
});
export type CarriedPassRecord = z.infer<typeof carriedPassRecordSchema>;
