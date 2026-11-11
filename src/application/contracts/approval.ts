import { z } from "zod";
import { gitShaSchema, identifierSchema, sha256Schema } from "./identifiers.js";
import { schemaVersionV1 } from "./schema-version.js";

const scopeIds = z
  .array(identifierSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length);
export const approvalSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("business"), baselineHash: sha256Schema, scopeIds }),
  z.strictObject({ kind: z.literal("cost"), estimateHash: sha256Schema, scopeIds }),
  z.strictObject({
    kind: z.literal("release"),
    pullRequestId: identifierSchema,
    headSha: gitShaSchema,
  }),
  z.strictObject({
    kind: z.literal("deploy"),
    artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be a sha256 artifact digest"),
    environment: identifierSchema,
  }),
]);

export const requestApprovalSchema = z.strictObject({
  schemaVersion: schemaVersionV1,
  subjectId: identifierSchema,
  kind: z.enum(["business", "cost", "release", "deploy"]),
  runId: identifierSchema.optional(),
  expiresAt: z.number().int().nonnegative().optional(),
});

/** Actor, source, authentication and approved=true are deliberately absent. */
export const recordApprovalSchema = z.strictObject({
  schemaVersion: schemaVersionV1,
  approvalId: identifierSchema,
  expectedVersion: z.number().int().nonnegative(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  pathway: z.enum(["cli", "github"]),
  evidenceRef: z.string().trim().min(1).max(1024).optional(),
});
export type RequestApprovalInput = z.infer<typeof requestApprovalSchema>;
export type RecordApprovalInput = z.infer<typeof recordApprovalSchema>;
