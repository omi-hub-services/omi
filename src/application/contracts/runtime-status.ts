import { z } from "zod";
import { RUN_STATUSES } from "../../domain/runs/workflow-run.js";
import { identifierSchema } from "./identifiers.js";
import { effortSchema, executorSchema, modelNameSchema } from "./model-capability.js";
import { schemaVersionV1 } from "./schema-version.js";

/**
 * What the runtime reports for the `status` command. The CLI validates it again before
 * rendering, so a runtime that answers with another shape is a protocol error, not a crash.
 */
export const runtimeStatusSchema = z.strictObject({
  schemaVersion: schemaVersionV1,
  state: z.literal("ready"),
  runtimeVersion: z.string().min(1).max(64),
  startedAt: z.iso.datetime(),
  attempts: z
    .array(
      z.strictObject({
        attemptId: identifierSchema,
        settings: z.strictObject({
          chosen: z.strictObject({
            executor: executorSchema,
            profileId: identifierSchema,
            model: modelNameSchema,
            effort: effortSchema,
          }),
          selectionReason: z.string().min(1).max(2000).optional(),
          actualModel: z.string().min(1).max(128).optional(),
          actualEffort: effortSchema.optional(),
        }),
      }),
    )
    .optional(),
  /** Runs that are not finished, so a new Coordinator session can find what to resume. */
  runs: z
    .array(
      z.strictObject({
        runId: identifierSchema,
        status: z.enum(RUN_STATUSES),
      }),
    )
    .optional(),
});
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
