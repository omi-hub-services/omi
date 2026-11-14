import { z } from "zod";
import { listApprovalsSchema, recordApprovalSchema, requestApprovalSchema } from "./approval.js";
import { identifierSchema, slugSchema } from "./identifiers.js";
import { mergeTaskPrSchema } from "./merge-delivery.js";
import { mergeReleaseSchema } from "./release-merge.js";
import { schemaVersionV1 } from "./schema-version.js";
import { registerProfileSchema } from "./profile-metadata.js";
import { importTaskSelectionSchema } from "./task-import.js";
import { retryStepSchema, reworkRecordSchema } from "./rework.js";
import { syncSelectionSchema } from "./sync.js";
import { prepareRunPrSchema } from "./pr-delivery.js";

const envelope = { schemaVersion: schemaVersionV1 };

/**
 * Coordinator → runtime commands (architecture.md §5). They change run state, so every object is
 * strict: an unknown field is an error, never silently dropped.
 */
export const commandSchema = z
  .discriminatedUnion("command", [
    syncSelectionSchema.extend({ ...envelope, command: z.literal("sync") }),
    importTaskSelectionSchema.extend({ ...envelope, command: z.literal("task.import") }),
    registerProfileSchema.extend({ ...envelope, command: z.literal("profile.register") }),
    z.strictObject({ ...envelope, command: z.literal("profile.list") }),
    z.strictObject({
      ...envelope,
      command: z.literal("profile.probe"),
      profileId: identifierSchema,
    }),
    requestApprovalSchema.extend({ command: z.literal("approval.request") }),
    listApprovalsSchema.extend({ ...envelope, command: z.literal("approval.list") }),
    recordApprovalSchema.extend({ command: z.literal("approval.decide") }),
    retryStepSchema.extend({ ...envelope, command: z.literal("retry") }),
    reworkRecordSchema.extend({ ...envelope, command: z.literal("rework.record") }),
    z.strictObject({
      ...envelope,
      command: z.literal("plan"),
      issueNumber: z.number().int().positive(),
      workflowId: slugSchema.optional(),
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("dispatch"),
      runId: identifierSchema,
      stepId: slugSchema,
      notes: z.string().trim().min(1).max(2000).optional(),
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("worker-report"),
      attemptId: identifierSchema,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("commit-worker"),
      attemptId: identifierSchema,
      message: z.string().trim().min(1).max(2000),
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("review-comment"),
      prNumber: z.number().int().positive(),
      body: z.string().min(1).max(60_000),
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("wait"),
      runId: identifierSchema,
      timeoutSeconds: z.number().int().min(1).max(3600),
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("status"),
      runId: identifierSchema.optional(),
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("pause"),
      runId: identifierSchema,
      reason: z.string().min(1).max(500),
    }),
    z.strictObject({ ...envelope, command: z.literal("resume"), runId: identifierSchema }),
    prepareRunPrSchema.extend({ ...envelope, command: z.literal("prepare-pr") }),
    z.strictObject({
      ...envelope,
      command: z.literal("deliver"),
      runId: identifierSchema,
      ...mergeTaskPrSchema.pick({
        prNumber: true,
        reviewedHeadSha: true,
        requiredChecks: true,
        minimumNativeApprovals: true,
      }).shape,
    }),
    // Repository and PO logins are trusted runtime configuration; a command never names them.
    mergeReleaseSchema
      .omit({ repository: true, poActors: true })
      .extend({ ...envelope, command: z.literal("release.merge") }),
    z.strictObject({
      ...envelope,
      command: z.literal("handoff"),
      reason: z.enum(["new-session", "profile-switch"]),
      toProfile: slugSchema.optional(),
    }),
  ])
  .meta({ title: "omi-squad command v1" });
export type Command = z.infer<typeof commandSchema>;
