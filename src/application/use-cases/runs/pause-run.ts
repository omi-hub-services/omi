import { z } from "zod";
import { transitionRun } from "../../../domain/runs/workflow-run.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import { identifierSchema } from "../../contracts/identifiers.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type { RecoveryRunReader, WorkerRecovery } from "../../ports/run-recovery.js";
import { PROJECT_OWNER_LEASE_KEY } from "../../services/claim-project-session.js";
import { quiesceRunWorkers, type QuiesceRefusal } from "../../services/quiesce-run-workers.js";
import {
  writeCheckpoint,
  type WriteCheckpointDependencies,
  type WriteCheckpointInput,
} from "./write-checkpoint.js";

export interface PauseRunDependencies extends WriteCheckpointDependencies {
  readonly session: ProjectSession;
  readonly runs: RecoveryRunReader;
  readonly processes: WorkerRecovery;
  /** Trusted workflow state. The use case fixes runId and kind after stopping writers. */
  readonly prepareSnapshot?: (runId: string) => Promise<void>;
  readonly snapshot: (runId: string) => Omit<WriteCheckpointInput, "runId" | "kind">;
}
export type PauseRunResult =
  | { readonly ok: true; readonly checkpointId: string }
  | {
      readonly ok: false;
      readonly reason:
        | QuiesceRefusal
        | "INVALID_INPUT"
        | "RUN_NOT_FOUND"
        | "RUN_NOT_PAUSABLE"
        | "CHECKPOINT_FAILED"
        | "STATE_REJECTED";
      readonly detail?: string;
    };

/** Called serially by the runtime holding project-owner. Keeps the session's lock on return. */
export async function pauseRun(
  deps: PauseRunDependencies,
  input: unknown,
): Promise<PauseRunResult> {
  const parsed = z.strictObject({ runId: identifierSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  if (deps.session.lease.resourceKey !== PROJECT_OWNER_LEASE_KEY || !deps.session.renew())
    return { ok: false, reason: "PROJECT_LOCK_LOST" };
  const run = deps.runs.get(parsed.data.runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  const transition = transitionRun(run.status, {
    type: "pause",
    checkpointSaved: true,
    writerStopped: true,
  });
  if (!transition.ok) return { ok: false, reason: "RUN_NOT_PAUSABLE" };
  const steps = deps.runs.listSteps(run.id);
  const stopped = await quiesceRunWorkers(deps, steps, true);
  if (!stopped.ok) return stopped;
  let saved: ReturnType<typeof writeCheckpoint>;
  try {
    if (deps.prepareSnapshot !== undefined) {
      await deps.prepareSnapshot(run.id);
      if (!deps.session.renew()) return { ok: false, reason: "PROJECT_LOCK_LOST" };
    }
    saved = writeCheckpoint(deps, { ...deps.snapshot(run.id), runId: run.id, kind: "pause" });
  } catch {
    return { ok: false, reason: "CHECKPOINT_FAILED" };
  }
  if (!saved.ok) return { ok: false, reason: "CHECKPOINT_FAILED", detail: saved.reason };
  for (const step of steps) {
    const paused = transitionStep(step.status, { type: "pause", writerStopped: true });
    if (!paused.ok) continue;
    const committed = deps.session.commit({
      target: { kind: "step_run", id: step.id, expectedVersion: step.version, toStatus: paused.to },
      event: {
        eventId: deps.nextId(),
        kind: "step.paused",
        subject: step.id,
        runId: run.id,
        correlationId: saved.checkpoint.id,
        payload: "{}",
      },
    });
    if (!committed.ok) return { ok: false, reason: "STATE_REJECTED", detail: committed.reason };
  }
  const committed = deps.session.commit({
    target: {
      kind: "workflow_run",
      id: run.id,
      expectedVersion: run.version,
      toStatus: transition.to,
    },
    event: {
      eventId: deps.nextId(),
      kind: "run.paused",
      subject: run.id,
      runId: run.id,
      correlationId: saved.checkpoint.id,
      payload: JSON.stringify({ checkpointId: saved.checkpoint.id }),
    },
  });
  return committed.ok
    ? { ok: true, checkpointId: saved.checkpoint.id }
    : { ok: false, reason: "STATE_REJECTED", detail: committed.reason };
}
