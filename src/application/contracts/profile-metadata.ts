import { z } from "zod";
import { PROFILE_STATES } from "../../domain/profiles/profile-state.js";
import type { ProfileMetadata } from "../../domain/profiles/profile-metadata.js";
import { assertCredentialFree } from "./credential-input.js";
import { absolutePathSchema, identifierSchema } from "./identifiers.js";
import { executorSchema, modelNameSchema } from "./model-capability.js";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const profileMetadataSchema = z
  .strictObject({
    profileId: identifierSchema,
    tool: executorSchema,
    authMode: z.literal("subscription"),
    credentialRef: absolutePathSchema,
    accountGroupId: identifierSchema,
    modelAllowlist: z.array(modelNameSchema).max(128),
    state: z.enum(PROFILE_STATES),
    lastProbeAt: timestamp.optional(),
    cooldownUntil: timestamp.optional(),
    probeTtlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxConcurrency: z.number().int().positive(),
    accountGroupMaxConcurrency: z.number().int().positive(),
    preference: z.number().int().nonnegative(),
  })
  .superRefine((profile, ctx) => {
    if (new Set(profile.modelAllowlist).size !== profile.modelAllowlist.length) {
      ctx.addIssue({ code: "custom", message: "modelAllowlist must not repeat models" });
    }
  });

/** Fixed error text keeps rejected external input (including secret-bearing extras) out of logs. */
export function parseProfileMetadata(input: unknown): ProfileMetadata {
  assertCredentialFree(input);
  const result = profileMetadataSchema.safeParse(input);
  if (!result.success) throw new Error("Invalid profile metadata");
  const { lastProbeAt, cooldownUntil, ...metadata } = result.data;
  return {
    ...metadata,
    ...(lastProbeAt === undefined ? {} : { lastProbeAt }),
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
  };
}
