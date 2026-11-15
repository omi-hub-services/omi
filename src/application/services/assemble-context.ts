import { z } from "zod";
import { artifactReferenceSchema } from "../contracts/artifact.js";
import { contextPacketSchema, type ContextPacket } from "../contracts/context.js";
import { slugSchema } from "../contracts/identifiers.js";
import { assertCredentialFree, type CredentialPolicy } from "../contracts/credential-input.js";

const audience = {
  roles: z.array(slugSchema).min(1),
  steps: z.array(slugSchema).min(1),
};
const manifestEntry = contextPacketSchema.shape.skillsManifest.element;
const assemblySchema = z.strictObject({
  context: contextPacketSchema.omit({
    skillsManifest: true,
    rulesManifest: true,
    inputArtifacts: true,
  }),
  skills: z.array(z.strictObject({ ...audience, reference: manifestEntry })),
  rules: z.array(z.strictObject({ ...audience, reference: manifestEntry })),
  inputs: z.array(z.strictObject({ ...audience, reference: artifactReferenceSchema })),
});
export type ContextAssembly = z.infer<typeof assemblySchema>;

export class ContextSelectionError extends Error {
  override readonly name = "ContextSelectionError";
  readonly code = "AMBIGUOUS_CONTEXT_INPUT";

  constructor() {
    super("Selected context entries must have unique ids and paths");
  }
}

/**
 * Pure assembly from a resolved, pinned catalog. Selectors must match BOTH step and role.
 * Curated skill aggregates are copied unchanged (ADR-0019), never rehashed as single files.
 * Sourced summaries are ordinary input artifacts, not extra inline/transcript fields in v1.
 */
export function assembleContext(input: unknown, policy: CredentialPolicy = {}): ContextPacket {
  // Inspect before validation so unknown credential fields cannot leak through validation errors.
  assertCredentialFree(input, policy);
  const { context, skills, rules, inputs } = assemblySchema.parse(input);
  const select = <T>(entries: readonly { roles: string[]; steps: string[]; reference: T }[]): T[] =>
    entries
      .filter((entry) => entry.roles.includes(context.role) && entry.steps.includes(context.stepId))
      .map((entry) => entry.reference);
  const packet = contextPacketSchema.parse({
    ...context,
    skillsManifest: select(skills),
    rulesManifest: select(rules),
    inputArtifacts: select(inputs),
  });
  for (const keys of [
    packet.skillsManifest.map((entry) => entry.id),
    packet.rulesManifest.map((entry) => entry.id),
    packet.inputArtifacts.map((entry) => entry.path),
  ]) {
    if (new Set(keys).size !== keys.length) throw new ContextSelectionError();
  }
  return packet;
}
