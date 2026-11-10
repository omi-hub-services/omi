import { z } from "zod";
import { slugSchema } from "./identifiers.js";
import { schemaVersionV1 } from "./schema-version.js";

const githubNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const branchNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/);

/** `.omi-squad/config/project.yaml`: repo, Project, branches, limits, policies. No secrets. */
export const projectConfigSchema = z
  .strictObject({
    schema_version: schemaVersionV1,
    repository: z.strictObject({ owner: githubNameSchema, name: githubNameSchema }),
    project: z.strictObject({ owner: githubNameSchema, number: z.number().int().positive() }),
    branches: z.strictObject({ integration: branchNameSchema, release: branchNameSchema }),
    limits: z.strictObject({
      max_parallel_workers: z.number().int().min(1).max(16),
      step_timeout_seconds: z.number().int().min(1).max(86_400),
      max_rework_cycles: z.number().int().min(0).max(10),
    }),
    policies: z.strictObject({
      /** Gates that always need a human; a runtime field must not remove them. */
      mandatory_approvals: z.array(slugSchema),
    }),
  })
  .meta({ title: "omi-squad project.yaml v1" });
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
