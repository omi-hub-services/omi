import { z } from "zod";
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
});
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
