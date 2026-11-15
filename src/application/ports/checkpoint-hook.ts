import type { ArtifactReference } from "../contracts/artifact.js";
import type { CheckpointKind } from "../contracts/checkpoint.js";

/** What a step-boundary use case knows when it asks for a checkpoint. Business progress that the
 * use case does not own (counters, decisions, config hashes, next action) is added by whoever
 * binds the hook, not here. */
export interface BoundaryCheckpointEvent {
  readonly kind: Extract<CheckpointKind, "before-dispatch" | "after-output">;
  readonly runId: string;
  readonly stepRunId: string;
  readonly stepId: string;
  readonly attemptId?: string;
  /** Task worktree, held with no writer process running when the hook is called. */
  readonly workspacePath: string;
  /** Output artifacts the runtime has already verified (after-output only). */
  readonly outputs: readonly ArtifactReference[];
}

export type BoundaryCheckpointOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Synchronous like every state-changing port; `writeCheckpoint` is the intended implementation. */
export type BoundaryCheckpointHook = (event: BoundaryCheckpointEvent) => BoundaryCheckpointOutcome;
