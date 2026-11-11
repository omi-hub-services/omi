import fs from "node:fs";
import type { AttemptRecord } from "../../application/ports/attempt-store.js";
import type {
  WorkerRecovery,
  WorkerState,
  WorkerProcessReference,
  WorkerProcessStore,
} from "../../application/ports/run-recovery.js";
import type { SupervisedProcess } from "./supervised-process.js";

function startIdentity(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = fields[19]; // proc stat field 22; the sliced fields start at field 3.
    if (ticks === undefined || !/^\d+$/.test(ticks)) return undefined;
    return `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
  } catch {
    return undefined;
  }
}

function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

/** Reuses session-runtime / owned-worker-run handles. Never adopts or signals a persisted PID.
 * The caller durably saves track()'s reference before permitting dispatch to continue. Missing
 * references (including a crash during spawn) fail closed and require explicit reconciliation.
 */
export function createWorkerRecovery(options: WorkerProcessStore) {
  const owned = new Map<
    string,
    { reference: WorkerProcessReference; worker: SupervisedProcess; stopped: boolean }
  >();
  const inspect = (attempt: AttemptRecord): WorkerState => {
    let reference: WorkerProcessReference | undefined;
    try {
      reference = options.reference(attempt.id);
    } catch {
      return "unknown";
    }
    if (reference === undefined) {
      return ["succeeded", "failed", "interrupted", "cancelled"].includes(attempt.status)
        ? "stopped"
        : "unknown";
    }
    if (
      !Number.isSafeInteger(reference.pid) ||
      reference.pid <= 0 ||
      reference.generation !== attempt.workspace.generation
    )
      return "unknown";
    const handle = owned.get(attempt.id);
    if (
      handle?.worker.pid === reference.pid &&
      handle.reference.startIdentity === reference.startIdentity &&
      handle.reference.generation === reference.generation &&
      handle.stopped
    )
      return "stopped";
    if (groupGone(reference.pid)) return "stopped";
    if (startIdentity(reference.pid) !== reference.startIdentity) return "unowned-running";
    return handle?.worker.pid === reference.pid &&
      handle.reference.startIdentity === reference.startIdentity &&
      handle.reference.generation === reference.generation
      ? "owned-running"
      : "unowned-running";
  };
  const recovery: WorkerRecovery = {
    inspect,
    async stopOwned(attempt) {
      const state = inspect(attempt);
      if (state === "stopped") return;
      if (state !== "owned-running") throw new Error("WORKER_NOT_OWNED");
      const handle = owned.get(attempt.id);
      if (handle === undefined) throw new Error("WORKER_NOT_OWNED");
      handle.worker.cancel("SIGINT", "group");
      await handle.worker.exit;
      handle.stopped = true;
    },
  };
  return {
    ...recovery,
    track(attempt: AttemptRecord, worker: SupervisedProcess): WorkerProcessReference {
      const identity = startIdentity(worker.pid);
      if (identity === undefined) {
        worker.cancel("SIGINT", "group");
        throw new Error("WORKER_IDENTITY_UNKNOWN");
      }
      const reference = {
        pid: worker.pid,
        startIdentity: identity,
        generation: attempt.workspace.generation,
      };
      try {
        options.saveReference(attempt, reference);
      } catch (error) {
        // The spawned handle is ours even if recording its identity failed. Stop it rather than
        // letting an unrecorded writer escape; supervision owns grace and escalation.
        worker.cancel("SIGINT", "group");
        throw error;
      }
      const handle = { worker, reference, stopped: false };
      owned.set(attempt.id, handle);
      void worker.exit.then(() => {
        handle.stopped = true;
      });
      return reference;
    },
  };
}
