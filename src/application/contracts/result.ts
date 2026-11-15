import { z } from "zod";
import { identifierSchema, relativePathSchema, sha256Schema, slugSchema } from "./identifiers.js";
import { schemaVersionV1 } from "./schema-version.js";

export const findingSchema = z.strictObject({
  id: slugSchema,
  severity: z.enum(["info", "minor", "major", "blocker"]),
  message: z.string().min(1).max(2000),
  location: z.string().min(1).max(512).optional(),
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * The regression test a bugfix worker wrote first. The worker only names it; a script runs it
 * against the base (fix reverted) and the head and records the exit codes (ADR-0042 decision 2).
 */
export const regressionTestSchema = z.strictObject({
  file: relativePathSchema.refine((path) => !path.startsWith("-"), "must not start with '-'"),
  name: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^\r\n]+$/, "must be one line"),
});
export type RegressionTest = z.infer<typeof regressionTestSchema>;

/**
 * What a worker reports for one attempt. It is a claim: the runtime verifies ids, paths and
 * artifacts before trusting it, and `succeeded` never makes a task Done. A worker without a shell
 * cannot hash files or read git, so `sha256` is optional (the runtime computes it, and a claimed
 * one must match) and `revision` is only a claim: the runtime records its own head and merge-base.
 */
export const stepResultSchema = z
  .strictObject({
    schemaVersion: schemaVersionV1,
    runId: identifierSchema,
    stepId: slugSchema,
    attemptId: identifierSchema,
    status: z.enum(["succeeded", "failed", "blocked"]),
    summary: z.string().min(1).max(4000),
    artifacts: z.array(
      z.strictObject({ path: relativePathSchema, sha256: sha256Schema.optional() }),
    ),
    revision: z
      .strictObject({
        headSha: z.string().max(200).optional(),
        baseSha: z.string().max(200).optional(),
      })
      .optional(),
    checks: z.array(z.strictObject({ id: slugSchema, evidenceRef: relativePathSchema })),
    /** One entry per skill the attempt was given: how the worker applied it, with evidence. */
    skillsApplied: z.array(z.strictObject({ id: slugSchema, evidenceRef: relativePathSchema })),
    findings: z.array(findingSchema),
    /** Bugfix `fix` step only: the test whose red/green run the script records. */
    regressionTest: regressionTestSchema.optional(),
    nextAction: slugSchema.optional(),
  })
  .meta({ title: "omi-squad step result v1" });
export type StepResult = z.infer<typeof stepResultSchema>;
