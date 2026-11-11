import type { CheckpointKind, CheckpointStatus } from "../contracts/checkpoint.js";

export interface CheckpointRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepRunId: string | undefined;
  readonly kind: CheckpointKind;
  /** Relative to the artifact root. */
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly gitRevision: string | undefined;
  readonly status: CheckpointStatus;
  readonly createdAt: string;
}

export interface CheckpointSave {
  readonly id: string;
  readonly runId: string;
  readonly stepRunId?: string;
  readonly kind: CheckpointKind;
  /** Canonical manifest JSON; the store hashes and persists exactly these bytes. */
  readonly bytes: Uint8Array;
  readonly gitRevision?: string;
  readonly createdAt: string;
}

export type CheckpointErrorCode = "INVALID_INPUT" | "ALREADY_EXISTS" | "NOT_FOUND" | "INCONSISTENT";

/** Fixed messages never echo manifest content. */
export class CheckpointError extends Error {
  override readonly name = "CheckpointError";
  readonly code: CheckpointErrorCode;

  constructor(code: CheckpointErrorCode) {
    super(`Checkpoint operation failed: ${code}`);
    this.code = code;
  }
}

export interface CheckpointReconciliation {
  /** Checkpoints newly marked `interrupted` by this pass. */
  readonly interrupted: readonly string[];
  /** Files under the checkpoint directory that no `valid` row references (collectable). */
  readonly orphanFiles: readonly string[];
}

/**
 * Atomic file + DB checkpoint persistence. `save` returns only after the manifest file is durable
 * and the row says `valid`. A crash at any point leaves either nothing, or a `pending`/stale row
 * that `reconcile` marks `interrupted`. Nothing but a `valid` row verified against its file is
 * ever returned as a resume point.
 */
export interface CheckpointStore {
  save(input: CheckpointSave): CheckpointRecord;
  get(checkpointId: string): CheckpointRecord | undefined;
  /** Newest `valid` checkpoint of the run whose file still matches its recorded hash. A row whose
   * file is missing or altered is marked `interrupted` and skipped. */
  latestValid(
    runId: string,
    at: string,
  ): { readonly record: CheckpointRecord; readonly bytes: Uint8Array } | undefined;
  /** Verifies every non-interrupted row of the run against its file. Never deletes anything. */
  reconcile(runId: string, at: string): CheckpointReconciliation;
}
