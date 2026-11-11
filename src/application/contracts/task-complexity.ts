import { z } from "zod";
import { DEFAULT_EFFORT_POLICY } from "../../domain/agents/complexity-policy.js";
import { effortSchema } from "./model-capability.js";

export const complexitySchema = z.enum(["low", "medium", "high"]);
export const effortPolicySchema = z
  .strictObject({
    low: effortSchema,
    medium: effortSchema,
    high: effortSchema,
  })
  .default(DEFAULT_EFFORT_POLICY);

/** Project metadata is data; only the explicit field/label can override inference. */
export const taskComplexitySchema = z
  .strictObject({
    workflow: z.string().max(128).nullable().default(null),
    workType: z.string().max(128).nullable().default(null),
    area: z.string().max(128).nullable().default(null),
    priority: z.string().max(128).nullable().default(null),
    acCount: z.number().int().nonnegative().default(0),
    labels: z.array(z.string().max(128)).max(128).default([]),
    hasLiveTests: z.boolean().optional(),
    complexity: complexitySchema.optional(),
  })
  .default({ workflow: null, workType: null, area: null, priority: null, acCount: 0, labels: [] });
