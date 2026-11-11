import type { RunStatus } from "../../domain/runs/workflow-run.js";
import type { StepRunRecord, AttemptRecord } from "./attempt-store.js";
import type { CheckpointManifest } from "../contracts/checkpoint.js";

export interface RecoveryRun {
  readonly id: string;
  readonly status: RunStatus;
  readonly version: number;
}

/** Current durable state, never reconstructed from a transcript or a checkpoint's nextAction. */
export interface RecoveryRunReader {
  get(runId: string): RecoveryRun | undefined;
  listSteps(runId: string): readonly StepRunRecord[];
}

export type WorkerState = "stopped" | "owned-running" | "unowned-running" | "unknown";

/** Inspect the entire process group, not just its leader. An absent identity is unknown.
 * Implementations must compare persisted start identity and lease generation before signalling.
 */
export interface WorkerRecovery {
  inspect(attempt: AttemptRecord): WorkerState;
  /** Only a handle owned by this runtime may be stopped. Resolves after the whole group exits. */
  stopOwned(attempt: AttemptRecord): Promise<void>;
}

/** Workflow owner revalidates current config/baseline, approvals and revision-bound checks.
 * Must use authoritative readers (e.g. checkExecutionApprovals), never checkpoint booleans.
 */
export type RecoveryGate = (
  checkpoint: CheckpointManifest,
  steps: readonly StepRunRecord[],
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;

/** Bind to dispatchStep with the current authorized execution plan. A retry allocates a new
 * attempt; do not invoke the old executor handle or derive authorization from nextAction text.
 */
export type RecoveryDispatch = (
  checkpoint: CheckpointManifest,
  step: StepRunRecord,
) => Promise<
  | { readonly ok: true; readonly attemptId: string }
  | { readonly ok: false; readonly reason: string }
>;

/** Durable Linux/WSL identity, stored in the existing agent_attempts process columns. */
export interface WorkerProcessReference {
  readonly pid: number;
  readonly startIdentity: string;
  readonly generation: number;
}
export interface WorkerProcessStore {
  reference(attemptId: string): WorkerProcessReference | undefined;
  saveReference(attempt: AttemptRecord, reference: WorkerProcessReference): void;
}
