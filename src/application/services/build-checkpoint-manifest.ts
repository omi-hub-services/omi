import { checkpointManifestSchema } from "../contracts/checkpoint.js";
import type { CheckpointManifest } from "../contracts/checkpoint.js";
import { assertCredentialFree } from "../contracts/credential-input.js";
import type { CredentialPolicy } from "../contracts/credential-input.js";
import type { ContentHasher } from "../ports/content-hasher.js";

export interface BuiltCheckpointManifest {
  readonly manifest: CheckpointManifest;
  /** Canonical UTF-8 JSON: schema key order, no insignificant whitespace. */
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/**
 * Validates a manifest candidate against the v1 schema and refuses it when any key or value looks
 * like a credential (ADR-0022). Throws `ZodError` or `CredentialInputError`; the message of the
 * latter never echoes the offending value. The same candidate always yields the same bytes.
 */
export function buildCheckpointManifest(
  hasher: ContentHasher,
  candidate: unknown,
  policy: CredentialPolicy = {},
): BuiltCheckpointManifest {
  const manifest = checkpointManifestSchema.parse(candidate);
  assertCredentialFree(manifest, policy);
  const text = JSON.stringify(manifest);
  return { manifest, bytes: new TextEncoder().encode(text), sha256: hasher.sha256(text) };
}
