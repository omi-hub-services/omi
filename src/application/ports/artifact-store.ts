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

/** Takes in files that a worker without a shell wrote itself, so the runtime can hash them. */
export interface ArtifactAdopter {
  /**
   * Registers a regular file a worker already wrote under the root and returns its reference with
   * the hash the runtime computed. Refuses a missing file (NOT_FOUND), a symlink or non-file
   * (INVALID_PATH), credential-looking content, and a path already registered with other bytes
   * (HASH_MISMATCH). Registering the same bytes again returns the same reference.
   */
  adopt(input: Omit<ArtifactWrite, "bytes">): ArtifactReference;
}

/** Runtime-owned, immutable files. Writes return only after file durability and DB commit. */
export interface ArtifactStore {
  write(input: ArtifactWrite): ArtifactReference;
  /** Verifies both the recorded hash and the caller's pinned hash before returning bytes. */
  read(reference: ArtifactReference): Uint8Array;
  /** Builds a verified manifest for explicit references only; never scans the artifact root. */
  manifest(references: readonly ArtifactReference[]): ArtifactManifest;
}
