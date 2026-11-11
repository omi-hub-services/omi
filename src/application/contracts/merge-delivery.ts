import { z } from "zod";
import { identifierSchema } from "./identifiers.js";
import { githubOperationSchema, shaSchema } from "./github-operation.js";

const pullOperation = githubOperationSchema.options[3];
const positiveInt = z.number().int().positive();
const checkNameSchema = z.string().trim().min(1).max(200);

/** One merge request for a task PR that `preparePr` delivered and mapped. */
export const mergeTaskPrSchema = z.strictObject({
  projectId: identifierSchema,
  taskId: identifierSchema,
  repository: pullOperation.shape.repo,
  issueNumber: positiveInt,
  prNumber: positiveInt,
  /** The head the independent review examined; the merge is guarded by it. */
  reviewedHeadSha: shaSchema,
  /** Checks the workflow requires; the base branch ruleset can add more, never remove any. */
  requiredChecks: z.array(checkNameSchema).min(1).max(50),
  /** The project's minimum; the ruleset's required approving review count applies when higher. */
  minimumNativeApprovals: z.number().int().min(0).max(10).default(0),
});
export type MergeTaskPrRequest = z.infer<typeof mergeTaskPrSchema>;

export const mergeableStateSchema = z.enum([
  "clean",
  "has_hooks",
  "unstable",
  "blocked",
  "behind",
  "dirty",
  "draft",
  "unknown",
]);

/** A PR as read from GitHub for a merge decision; identity is checked by the adapter. */
export const mergePullSchema = z.strictObject({
  number: positiveInt,
  repository: pullOperation.shape.repo,
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  headSha: shaSchema,
  baseRef: z.string().min(1),
  author: z.string().min(1),
  mergeableState: mergeableStateSchema,
  mergeCommitSha: shaSchema.nullable(),
  body: z.string(),
});
export type MergePull = z.infer<typeof mergePullSchema>;

export const issueStateSchema = z.strictObject({
  number: positiveInt,
  state: z.enum(["open", "closed"]),
  body: z.string(),
});
export type IssueState = z.infer<typeof issueStateSchema>;

/** What the base branch's rulesets require, as read from GitHub. */
export const branchRulesSchema = z.strictObject({
  requiredApprovingReviewCount: z.number().int().min(0),
  requiredChecks: z.array(checkNameSchema),
});
export type BranchRules = z.infer<typeof branchRulesSchema>;

export const checkObservationsSchema = z.array(
  z.strictObject({
    name: checkNameSchema,
    headSha: shaSchema,
    status: z.enum(["passed", "failed", "pending"]),
  }),
);
export type CheckObservations = z.infer<typeof checkObservationsSchema>;

export const nativeReviewsSchema = z.array(
  z.strictObject({
    actor: z.string().min(1),
    actorType: z.string().min(1),
    state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
    commitSha: shaSchema,
  }),
);
export type NativeReviews = z.infer<typeof nativeReviewsSchema>;

export const mergeCommitSchema = z.strictObject({
  sha: shaSchema,
  parents: z.array(shaSchema),
});
export type MergeCommit = z.infer<typeof mergeCommitSchema>;

/**
 * The task's delivery evidence from local state: the latest recorded result of the independent
 * review step for one head, who implemented the change, and the workflow's own gates. The review
 * `body` is the reviewer's report; only its `AC-<n>` lines are read.
 */
export const mergeEvidenceSchema = z.strictObject({
  review: z
    .strictObject({
      reviewerRunId: z.string(),
      reviewerAgentId: z.string(),
      headSha: shaSchema,
      baseSha: shaSchema,
      verdict: z.enum(["pass", "fail"]),
      body: z.string().max(60_000),
    })
    .optional(),
  /** Without the implementers, independence cannot be proven, so both lists must be known. */
  authorRunIds: z.array(z.string().trim().min(1)).min(1),
  authorAgentIds: z.array(z.string().trim().min(1)).min(1),
  unresolvedMandatoryFindings: z.number().int().min(0),
  workflowGatesPassed: z.boolean(),
});
export type MergeEvidence = z.infer<typeof mergeEvidenceSchema>;
