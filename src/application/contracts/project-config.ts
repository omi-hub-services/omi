import { z } from "zod";
import { absolutePathSchema, identifierSchema, slugSchema } from "./identifiers.js";
import { effortPolicySchema } from "./task-complexity.js";
import { schemaVersionV1 } from "./schema-version.js";
import { logRetentionConfigSchema } from "./log-retention.js";

const githubNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const branchNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/);

const resourceWaitSchema = z
  .strictObject({
    // One second notices freed slots promptly; the cap limits repeated unavailable probes.
    interval_ms: z.number().int().min(1).max(2147483647).default(1000),
    max_backoff_ms: z.number().int().min(1).max(2147483647).default(60000),
  })
  .refine((settings) => settings.max_backoff_ms >= settings.interval_ms, {
    message: "max_backoff_ms must be at least interval_ms",
  });

/**
 * Quota-aware profile choice (ADR-0033). Absent block = no quota gating, so older configs keep
 * their behaviour. Thresholds are the share (%) of a window that must be left.
 */
const quotaPolicySchema = z.strictObject({
  min_five_hour_left_percent: z.number().min(0).max(100).default(10),
  min_seven_day_left_percent: z.number().min(0).max(100).default(10),
  coordinator_shared_penalty: z.number().min(0).max(100).default(20),
  /** What to do with a listed profile that shares the Coordinator's subscription account. */
  coordinator_shared_policy: z.enum(["penalize", "forbid"]).default("penalize"),
  coordinator_shared_profiles: z.array(identifierSchema).max(64).default([]),
  stale_after_minutes: z.number().int().min(1).max(10_080).default(120),
  /** Spend one minimal subscription call to refresh a stale Claude reading. Off by default. */
  probe_when_stale: z.boolean().default(false),
});

/**
 * Project checks the runtime runs itself (OMI-085), keyed by the id workflow steps require. The
 * command is an argv array run without a shell in the attempt's worktree. Absent block = the
 * runtime runs nothing, so older configs keep their behaviour and their hash.
 */
const checksSchema = z.record(
  slugSchema,
  z.strictObject({
    command: z.array(z.string().min(1).max(1000)).min(1).max(64),
    timeout_seconds: z.number().int().min(1).max(86_400).default(600),
  }),
);

/** Opaque GitHub IDs: modern URL-safe IDs, legacy padded base64, and short option IDs. */
export const githubIdSchema = z.string().regex(/^[A-Za-z0-9_+/=-]{1,256}$/);
export const projectFieldMappingSchema = z.record(
  slugSchema,
  z.strictObject({
    field_id: githubIdSchema,
    data_type: z.string().regex(/^[A-Z][A-Z_]{0,63}$/),
    options: z.record(slugSchema, githubIdSchema),
  }),
);

/** `.omi-squad/config/project.yaml`: repo, Project, branches, limits, policies. No secrets. */
export const projectConfigSchema = z
  .strictObject({
    schema_version: schemaVersionV1,
    repository: z.strictObject({ owner: githubNameSchema, name: githubNameSchema }),
    project: z.strictObject({
      owner: githubNameSchema,
      number: z.number().int().positive(),
      /** Additive v1 extension: older configs remain readable. Init always supplies these. */
      mapping: z
        .strictObject({
          id: githubIdSchema,
          owner_type: z.enum(["Organization", "User"]),
          fields: projectFieldMappingSchema,
        })
        .optional(),
    }),
    branches: z.strictObject({ integration: branchNameSchema, release: branchNameSchema }),
    limits: z.strictObject({
      max_parallel_workers: z.number().int().min(1).max(16),
      step_timeout_seconds: z.number().int().min(1).max(86_400),
      max_rework_cycles: z.number().int().min(0).max(10),
    }),
    effort_policy: effortPolicySchema,
    resource_wait: resourceWaitSchema.prefault({}),
    quota: quotaPolicySchema.optional(),
    checks: checksSchema.optional(),
    /** Worker log retention (OMI-080). Absent block = defaults. */
    log_retention: logRetentionConfigSchema.optional(),
    workspace: z.strictObject({ worktree_root: absolutePathSchema }).optional(),
    policies: z.strictObject({
      /** Gates that always need a human; a runtime field must not remove them. */
      mandatory_approvals: z.array(slugSchema),
      /** Empty/absent refuses all GitHub decisions; the native runtime TTY remains available. */
      github_approval_actors: z.array(githubNameSchema).max(100).optional(),
    }),
  })
  .meta({ title: "omi-squad project.yaml v1" });
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
