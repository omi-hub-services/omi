import { z } from "zod";
import { deployOperationSchema } from "./github-operation.js";
import { identifierSchema, sha256Schema } from "./identifiers.js";

export const deployReleaseSchema = z.strictObject({
  repository: deployOperationSchema.shape.repo,
  environment: deployOperationSchema.shape.deploymentEnvironment,
  artifactDigest: deployOperationSchema.shape.artifactDigest,
  approvalId: identifierSchema,
  rollback: z
    .strictObject({
      runbookRef: identifierSchema,
      approvalId: identifierSchema,
    })
    .optional(),
});

/** Trusted workflow configuration, never worker supplied approval provenance. */
export const deployPipelineSchema = z.strictObject({
  workflow: deployOperationSchema.shape.workflow,
  ref: deployOperationSchema.shape.ref,
  workflowSha: deployOperationSchema.shape.workflowSha,
  issueNumber: z.number().int().positive(),
  allowedActors: deployOperationSchema.shape.allowedActors,
  authorActor: deployOperationSchema.shape.authorActor,
});

/** Runbook revision read by the owning workflow, not accepted from the command. */
export const rollbackRunbookSchema = z.strictObject({
  reference: z.string().min(1),
  revisionHash: sha256Schema,
  repository: deployOperationSchema.shape.repo,
  environment: deployOperationSchema.shape.deploymentEnvironment,
  previousDigest: deployOperationSchema.shape.artifactDigest,
});
export type RollbackRunbook = z.infer<typeof rollbackRunbookSchema>;

export const deployEvidenceSchema = z.strictObject({
  runId: z.number().int().positive(),
  conclusion: z.string().min(1).nullable(),
  status: z.string().min(1),
  deploymentId: z.number().int().positive().nullable(),
  deploymentStatus: z.string().min(1).nullable(),
  artifactDigest: deployOperationSchema.shape.artifactDigest,
  nativeApproved: z.boolean(),
});
export type DeployEvidence = z.infer<typeof deployEvidenceSchema>;
