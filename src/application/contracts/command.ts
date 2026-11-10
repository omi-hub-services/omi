import { z } from "zod";
import { identifierSchema, slugSchema } from "./identifiers.js";
import { schemaVersionV1 } from "./schema-version.js";

const envelope = { schemaVersion: schemaVersionV1 };

/**
 * Coordinator → runtime commands (architecture.md §5). They change run state, so every object is
 * strict: an unknown field is an error, never silently dropped.
 */
export const commandSchema = z
  .discriminatedUnion("command", [
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
  ])
  .meta({ title: "omi-squad command v1" });
export type Command = z.infer<typeof commandSchema>;
