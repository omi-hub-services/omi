import { z } from "zod";
import { artifactReferenceSchema } from "./artifact.js";
import { gitShaSchema, slugSchema } from "./identifiers.js";

/**
 * What the runtime itself observed when it ran one required check in the attempt's worktree
 * (architecture.md §6.3). Unlike a worker's `checks` entry this is not a claim: the runtime
 * produced it, and `evidence` is the stored, redacted log with command, exit status and times.
 */
export const checkRunRecordSchema = z.strictObject({
  checkId: slugSchema,
  status: z.enum(["passed", "failed", "timed-out"]),
  /** Null when the command could not start or was killed by a signal. */
  exitCode: z.number().int().nullable(),
  command: z.array(z.string().min(1)).min(1),
  startedAt: z.iso.datetime({ precision: 3 }),
  endedAt: z.iso.datetime({ precision: 3 }),
  /** HEAD of the worktree the command ran on. */
  revision: gitShaSchema,
  evidence: artifactReferenceSchema,
});
export type CheckRunRecord = z.infer<typeof checkRunRecordSchema>;
