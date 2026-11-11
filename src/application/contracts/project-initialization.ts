import { z } from "zod";
import {
  githubIdSchema,
  projectConfigSchema,
  projectFieldMappingSchema,
} from "./project-config.js";
import { slugSchema } from "./identifiers.js";

export const projectLocatorSchema = projectConfigSchema.shape.project.pick({
  owner: true,
  number: true,
});
export type ProjectLocator = z.infer<typeof projectLocatorSchema>;

export const projectOwnerSchema = z.strictObject({
  id: githubIdSchema,
  login: projectConfigSchema.shape.project.shape.owner,
  type: z.enum(["Organization", "User"]),
});
export type ProjectOwner = z.infer<typeof projectOwnerSchema>;

export const inspectedProjectSchema = z.strictObject({
  id: githubIdSchema,
  number: z.number().int().positive(),
  title: z.string().max(1024),
  owner: projectOwnerSchema,
  fields: z.array(
    z.strictObject({
      id: githubIdSchema,
      name: z.string().max(1024),
      dataType: z.string().regex(/^[A-Z][A-Z_]{0,63}$/),
      options: z.array(z.strictObject({ id: githubIdSchema, name: z.string().max(1024) })),
    }),
  ),
});
export type InspectedProject = z.infer<typeof inspectedProjectSchema>;

export const initializeProjectSchema = z.strictObject({
  /** A caller-selected baseline; no hidden repository/branch/policy defaults. */
  config: projectConfigSchema,
  apply: z.boolean().default(false),
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("existing"),
      project: projectLocatorSchema,
      fields: projectFieldMappingSchema,
    }),
    z.strictObject({
      kind: z.literal("template"),
      template: projectLocatorSchema,
      owner: projectConfigSchema.shape.project.shape.owner,
      title: z.string().min(1).max(100),
      /** Reuse the same key to resume; a different payload for the key is refused. */
      operationKey: slugSchema,
    }),
  ]),
});
export type InitializeProjectInput = z.input<typeof initializeProjectSchema>;
