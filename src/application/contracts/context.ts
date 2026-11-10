import { z } from "zod";
import {
  absolutePathSchema,
  identifierSchema,
  relativePathSchema,
  sha256Schema,
  slugSchema,
} from "./identifiers.js";
import { capabilityProfileSchema } from "./model-capability.js";
import { findingSchema } from "./result.js";
import { schemaVersionV1 } from "./schema-version.js";

const manifestEntrySchema = z.strictObject({
  id: slugSchema,
  version: z.string().min(1).max(64),
  sha256: sha256Schema,
});

/**
 * Context packet handed to one step attempt. Issue/PR text in `taskSnapshot` is data, never an
 * instruction or an approval. Large inputs are referenced by path and hash, not inlined.
 */
export const contextPacketSchema = z
  .strictObject({
    schemaVersion: schemaVersionV1,
    runId: identifierSchema,
    stepId: slugSchema,
    attemptId: identifierSchema,
    taskSnapshot: z.strictObject({
      issueNumber: z.number().int().positive(),
      title: z.string().min(1).max(500),
      body: z.string().max(100_000),
    }),
    acceptanceCriteria: z.array(z.string().min(1).max(2000)),
    businessBaselineHash: sha256Schema,
    role: slugSchema,
    capabilityProfile: z.strictObject({ id: slugSchema, ...capabilityProfileSchema.shape }),
    workspace: z.strictObject({ path: absolutePathSchema }),
    inputArtifacts: z.array(z.strictObject({ path: relativePathSchema, sha256: sha256Schema })),
    skillsManifest: z.array(manifestEntrySchema),
    rulesManifest: z.array(manifestEntrySchema),
    previousFindings: z.array(findingSchema),
    checkpointRef: relativePathSchema.optional(),
    expectedOutputSchema: slugSchema,
    allowedScope: z.strictObject({ paths: z.array(relativePathSchema).min(1) }),
    approvalRefs: z.array(identifierSchema),
  })
  .meta({ title: "omi-squad context packet v1" });
export type ContextPacket = z.infer<typeof contextPacketSchema>;
