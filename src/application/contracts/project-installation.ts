import { z } from "zod";
import { wslPathSchema, sessionLaunchSchema } from "./session-launch.js";

export const installationInputSchema = z.strictObject({
  projectDir: wslPathSchema,
  packageDir: wslPathSchema,
  distribution: sessionLaunchSchema.shape.distribution.unwrap(),
  apply: z.boolean().default(false),
});
export type InstallationInput = z.infer<typeof installationInputSchema>;
export const releaseVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const releaseInstallationInputSchema = installationInputSchema
  .omit({ packageDir: true })
  .extend({
    version: releaseVersionSchema,
    acceptBreaking: z.boolean().default(false),
  });
const templatePathSchema = z
  .string()
  .regex(
    /^(?:(workflows|roles|rules|skills|config|provenance)\/[A-Za-z0-9._/-]+|bridge\/(?:CLAUDE\.md|AGENTS\.md|skill\/(?:SKILL\.md|bridge\.ts|bridge\.config\.json)|skills\/omi-(?:status|next|watch)\/SKILL\.md))$/,
  )
  .refine((path) => path.split("/").every((part) => part !== ".." && part !== "." && part !== ""));
export const templateFilesSchema = z.record(templatePathSchema, z.string().max(1024 * 1024));
export const frameworkLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  distribution: sessionLaunchSchema.shape.distribution.unwrap(),
  projectDir: wslPathSchema,
  base: templateFilesSchema,
});
export type FrameworkLock = z.infer<typeof frameworkLockSchema>;
export type TemplateFiles = z.infer<typeof templateFilesSchema>;
