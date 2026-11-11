import { z } from "zod";
import {
  gitShaSchema,
  identifierSchema,
  relativePathSchema,
  sha256Schema,
  slugSchema,
} from "./identifiers.js";
import { findingSchema } from "./result.js";
import { schemaVersionV1 } from "./schema-version.js";

/** Architecture §10: before dispatch, after confirmed output, around external effects, on pause. */
export const CHECKPOINT_KINDS = [
  "before-dispatch",
  "after-output",
  "before-side-effect",
  "after-side-effect",
  "pause",
] as const;
export const checkpointKindSchema = z.enum(CHECKPOINT_KINDS);
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

export const UNCOMMITTED_STATUSES = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "conflicted",
  "untracked",
] as const;

const hashedEntrySchema = z.strictObject({
  id: slugSchema,
  version: z.string().min(1).max(64),
  sha256: sha256Schema,
});

/**
 * One file with uncommitted work. Only a path, status and content hash: contents are never copied
 * (the worktree itself preserves them), so a snapshot cannot carry a secret that sits in a file.
 */
export const uncommittedFileSchema = z.strictObject({
  path: relativePathSchema,
  status: z.enum(UNCOMMITTED_STATUSES),
  staged: z.boolean(),
  /** Null for a deleted file, a non-regular file, or one over the size limit. */
  sha256: sha256Schema.nullable(),
  size: z.number().int().nonnegative().nullable(),
});
export type UncommittedFile = z.infer<typeof uncommittedFileSchema>;

export const uncommittedManifestSchema = z.strictObject({
  entries: z.array(uncommittedFileSchema).max(1000),
  /** More changed files existed than the limit allowed. */
  truncated: z.boolean(),
  /** Paths left out because they look like credential files; never listed, only counted. */
  excludedCredentialPaths: z.number().int().nonnegative(),
});
export type UncommittedManifest = z.infer<typeof uncommittedManifestSchema>;

const counterKey = z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/);

/**
 * Tool-independent business checkpoint: everything needed to resume the work without a session
 * transcript. It holds ids, hashes, counters and short business text only; credentials and
 * secret values are rejected when the manifest is built (ADR-0022).
 */
export const checkpointManifestSchema = z
  .strictObject({
    schemaVersion: schemaVersionV1,
    checkpointId: identifierSchema,
    kind: checkpointKindSchema,
    createdAt: z.iso.datetime({ precision: 3 }),
    runId: identifierSchema,
    stepRunId: identifierSchema.optional(),
    stepId: slugSchema.optional(),
    attemptId: identifierSchema.optional(),
    attemptNumber: z.number().int().positive().optional(),
    hashes: z.strictObject({
      config: sha256Schema,
      template: sha256Schema,
      skills: z.array(hashedEntrySchema),
      rules: z.array(hashedEntrySchema),
    }),
    taskSnapshot: z.strictObject({
      issueNumber: z.number().int().positive(),
      title: z.string().min(1).max(500),
      body: z.string().max(100_000),
    }),
    acceptanceCriteria: z.array(z.string().min(1).max(2000)),
    businessBaselineHash: sha256Schema,
    /** Rework, retry, quality-cycle counters. They survive profile/model changes. */
    counters: z.record(counterKey, z.number().int().nonnegative()),
    decisions: z.array(
      z.strictObject({
        id: slugSchema,
        summary: z.string().min(1).max(2000),
        decidedAt: z.iso.datetime({ precision: 3 }).optional(),
      }),
    ),
    approvalRefs: z.array(identifierSchema),
    outputs: z.array(
      z.strictObject({
        path: relativePathSchema,
        sha256: sha256Schema,
        size: z.number().int().nonnegative(),
      }),
    ),
    git: z.strictObject({
      worktreePath: z.string().min(1).max(1024),
      headSha: gitShaSchema,
      branch: z.string().min(1).max(256).nullable(),
      dirty: z.boolean(),
    }),
    uncommitted: uncommittedManifestSchema,
    previousFindings: z.array(findingSchema),
    nextAction: z.strictObject({
      action: slugSchema,
      stepId: slugSchema.optional(),
      note: z.string().min(1).max(2000).optional(),
    }),
  })
  .meta({ title: "omi-squad checkpoint manifest v1" });
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

export const CHECKPOINT_STATUSES = ["pending", "valid", "interrupted"] as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

/** Where a checkpoint manifest lives, relative to the artifact root. */
export function checkpointManifestPath(runId: string, checkpointId: string): string {
  return `checkpoints/${runId}/${checkpointId}.json`;
}
