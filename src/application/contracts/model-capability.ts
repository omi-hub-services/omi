import { z } from "zod";
import { slugSchema } from "./identifiers.js";
import { schemaVersionV1 } from "./schema-version.js";

/** Reasoning effort, ordered from lowest to highest (Claude Code `--effort` levels). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const effortSchema = z.enum(EFFORT_LEVELS);
export type Effort = z.infer<typeof effortSchema>;

export function effortRank(effort: Effort): number {
  return EFFORT_LEVELS.indexOf(effort);
}

/** Minimum capability a step needs from the executor that runs it. */
export const capabilityProfileSchema = z.strictObject({
  min_effort: effortSchema,
});
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;

export const EXECUTORS = ["claude-code", "codex"] as const;
export const executorSchema = z.enum(EXECUTORS);

const modelDeclarationSchema = z.strictObject({
  executor: executorSchema,
  /** Name passed to the CLI (`--model`). Not a credential. */
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, "must be a plain model name"),
  supported_efforts: z.array(effortSchema).min(1).max(EFFORT_LEVELS.length),
});
export type ModelDeclaration = z.infer<typeof modelDeclarationSchema>;

/**
 * `.omi-squad/config/models.yaml`: model aliases, the efforts each supports, the capability
 * profiles steps refer to, and which aliases are verified for each profile. No credentials:
 * unknown fields are rejected.
 *
 * Cross-references (profile and alias exist, verified alias supports the profile's minimum
 * effort, no duplicate efforts) are checked here, but JSON Schema cannot express them.
 */
export const modelsConfigSchema = z
  .strictObject({
    schema_version: schemaVersionV1,
    models: z.record(slugSchema, modelDeclarationSchema),
    capability_profiles: z.record(slugSchema, capabilityProfileSchema),
    verified_models: z.record(slugSchema, z.array(slugSchema).min(1)),
  })
  .meta({ title: "omi-squad models.yaml v1" })
  .superRefine((config, ctx) => {
    for (const [alias, model] of Object.entries(config.models)) {
      if (new Set(model.supported_efforts).size !== model.supported_efforts.length) {
        ctx.addIssue({
          code: "custom",
          path: ["models", alias, "supported_efforts"],
          message: "supported_efforts must not repeat a level",
        });
      }
    }
    for (const [profileId, aliases] of Object.entries(config.verified_models)) {
      const profile = config.capability_profiles[profileId];
      if (profile === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["verified_models", profileId],
          message: `unknown capability profile "${profileId}"`,
        });
        continue;
      }
      aliases.forEach((alias, index) => {
        const model = config.models[alias];
        if (model === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["verified_models", profileId, index],
            message: `unknown model alias "${alias}"`,
          });
        } else if (
          !model.supported_efforts.some((e) => effortRank(e) >= effortRank(profile.min_effort))
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["verified_models", profileId, index],
            message: `model "${alias}" supports no effort >= ${profile.min_effort} required by "${profileId}"`,
          });
        }
      });
    }
  });
export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
