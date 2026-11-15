import { z } from "zod";
import { mergeTaskPrSchema } from "./merge-delivery.js";
import { gitShaSchema } from "./identifiers.js";
import { prepareReleaseSchema } from "./release-delivery.js";

/** Trusted release workflow configuration, never worker approval claims. */
export const releaseMergeRequestSchema = z.strictObject({
  repository: mergeTaskPrSchema.shape.repository,
  prNumber: z.number().int().positive(),
  expectedHeadSha: gitShaSchema,
  poActors: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]+$/),
    )
    .min(1),
  requiredChecks: mergeTaskPrSchema.shape.requiredChecks,
});
export type ReleaseMergeRequest = z.infer<typeof releaseMergeRequestSchema>;

/** The gate request plus the release label whose PR creation intent marks the PR as this release's. */
export const mergeReleaseSchema = releaseMergeRequestSchema.extend({
  release: prepareReleaseSchema.shape.release,
});
export type MergeReleaseRequest = z.infer<typeof mergeReleaseSchema>;

export const releaseRestrictionsSchema = z.strictObject({
  canMerge: z.boolean(),
  requiredApprovingReviewCount: z.number().int().min(0),
  requiredChecks: z.array(z.string().min(1)),
});
export type ReleaseRestrictions = z.infer<typeof releaseRestrictionsSchema>;
