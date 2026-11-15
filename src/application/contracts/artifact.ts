import { z } from "zod";
import { identifierSchema, relativePathSchema, sha256Schema, slugSchema } from "./identifiers.js";

/** Canonical file names prevent aliases from bypassing the DB's unique relative path. */
export const artifactPathSchema = relativePathSchema.refine(
  (path) =>
    path.split("/").every((part) => part !== "" && part !== "." && !/^[A-Za-z]:/.test(part)),
  "must be a canonical relative file path without drive segments",
);

export const artifactReferenceSchema = z.strictObject({
  path: artifactPathSchema,
  sha256: sha256Schema,
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

export const artifactWriteSchema = z.strictObject({
  id: identifierSchema,
  path: artifactPathSchema,
  bytes: z.instanceof(Uint8Array),
  producerAttemptId: identifierSchema.optional(),
  classification: slugSchema,
  createdAt: z.iso.datetime({ precision: 3 }),
});
export type ArtifactWrite = z.infer<typeof artifactWriteSchema>;

export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly artifacts: readonly (ArtifactReference & { readonly size: number })[];
}
