import { z } from "zod";
import { mergeTaskPrSchema } from "./merge-delivery.js";
import { gitShaSchema } from "./identifiers.js";

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

export const releaseRestrictionsSchema = z.strictObject({
  canMerge: z.boolean(),
  requiredApprovingReviewCount: z.number().int().min(0),
  requiredChecks: z.array(z.string().min(1)),
});
export type ReleaseRestrictions = z.infer<typeof releaseRestrictionsSchema>;
