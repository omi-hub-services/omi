import { z } from "zod";
import { githubOperationSchema } from "./github-operation.js";

const issueOperation = githubOperationSchema.options[2];
export const prepareReleaseSchema = z.strictObject({
  repository: issueOperation.shape.repo,
  /** Stable release label, e.g. `2026-11-11` or `v0.2.0`; part of the idempotency keys. */
  release: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  title: issueOperation.shape.title.optional(),
});
export type PrepareReleaseRequest = z.infer<typeof prepareReleaseSchema>;

export const mergedPullSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  head: z.string(),
  mergedAt: z.iso.datetime(),
});
