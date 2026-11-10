import type { ArtifactManifest, ArtifactReference, ArtifactWrite } from "../contracts/artifact.js";

export type ArtifactErrorCode =
  "INVALID_PATH" | "NOT_FOUND" | "HASH_MISMATCH" | "ALREADY_EXISTS" | "HARD_LINK_UNSUPPORTED";

/** Fixed messages never echo an untrusted path, content or credential. */
export class ArtifactError extends Error {
  override readonly name = "ArtifactError";
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode) {
    super(`Artifact operation failed: ${code}`);
    this.code = code;
  }
}

/** Runtime-owned, immutable files. Writes return only after file durability and DB commit. */
export interface ArtifactStore {
  write(input: ArtifactWrite): ArtifactReference;
  /** Verifies both the recorded hash and the caller's pinned hash before returning bytes. */
  read(reference: ArtifactReference): Uint8Array;
  /** Builds a verified manifest for explicit references only; never scans the artifact root. */
  manifest(references: readonly ArtifactReference[]): ArtifactManifest;
}
