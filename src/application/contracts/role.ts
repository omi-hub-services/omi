import { z } from "zod";
import { slugSchema } from "./identifiers.js";
import { schemaVersionV1 } from "./schema-version.js";

const uniqueSlugs = z
  .array(slugSchema)
  .default([])
  .refine((ids) => new Set(ids).size === ids.length, "must not list the same id twice");

/**
 * Role template (`.omi-squad/roles/*.yaml`). A role names a responsibility and the skills and
 * rules it loads. It deliberately has no tool, model, profile or executor field: the schema is
 * strict, so such a field is rejected instead of silently binding execution (product-overview
 * §2, §8). Tool and model come from the step's capability profile at selection time.
 */
export const roleSchema = z
  .strictObject({
    schema_version: schemaVersionV1,
    id: slugSchema,
    version: z.number().int().positive(),
    title: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    skills: uniqueSlugs,
    rules: uniqueSlugs,
  })
  .meta({ title: "omi-squad role v1" });
export type Role = z.infer<typeof roleSchema>;

/**
 * Front matter of `.omi-squad/rules/*.md`. A mandatory rule is a gate: it is always resolved
 * for every role and step, and nothing may drop it.
 */
export const ruleMetadataSchema = z
  .strictObject({
    id: slugSchema,
    version: z.number().int().positive(),
    mandatory: z.boolean(),
  })
  .meta({ title: "omi-squad rule front matter v1" });
export type RuleMetadata = z.infer<typeof ruleMetadataSchema>;
