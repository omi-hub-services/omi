import { z } from "zod";
import { importTaskSelectionSchema, storedTaskImportSchema } from "./task-import.js";
import { schemaVersionV1 } from "./schema-version.js";

export const syncSelectionSchema = importTaskSelectionSchema.partial();

const operation = z.strictObject({
  operationKey: z.string(),
  outcome: z.enum([
    "succeeded",
    "pending",
    "waiting",
    "unavailable",
    "deferred",
    "stale",
    "unreadable",
    "rejected_retry",
    "failed",
    "outcome_unknown",
    "gave_up",
    "skipped",
  ]),
  remoteIdentity: z.string().optional(),
  code: z.string().optional(),
  reason: z.string().optional(),
  notBefore: z.iso.datetime().optional(),
});

export const syncReportSchema = z.strictObject({
  schemaVersion: schemaVersionV1,
  reconcile: z.strictObject({ entries: z.array(operation), githubUnavailable: z.boolean() }),
  attempts: z.array(operation),
  snapshots: storedTaskImportSchema.shape.snapshots,
  githubUnavailable: z.boolean(),
  stopped: z.enum(["GITHUB_UNAVAILABLE", "RATE_LIMITED", "OUTCOME_UNKNOWN", "STALE"]).optional(),
  /** A completed pass can carry partial results and a stable non-success classification. */
  code: z.string().optional(),
});
export type SyncReport = z.infer<typeof syncReportSchema>;
