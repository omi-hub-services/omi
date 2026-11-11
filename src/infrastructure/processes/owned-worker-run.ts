import {
  watchOwnerLiveness,
  type OwnerGone,
  type OwnerLivenessOptions,
} from "./owner-liveness.js";
import {
  startSupervisedProcess,
  type ProcessExit,
  type SupervisedProcess,
  type SupervisedProcessOptions,
} from "./supervised-process.js";

export interface OwnedWorkerRunOptions {
  worker: SupervisedProcessOptions;
  owner: OwnerLivenessOptions;
}

export interface OwnedWorkerResult {
  /** Why the owner was considered gone; `null` when the worker ended on its own first. */
  ownerGone: OwnerGone | null;
  workerExit: ProcessExit;
}

export interface OwnedWorkerRun {
  /** The worker this run owns; `worker.pid` is the process group that gets stopped. */
  readonly worker: SupervisedProcess;
  /**
   * Resolves when the owner is gone, so a dispatcher can stop handing out work. It never resolves
   * when the worker ends first.
   */
  readonly ownerGone: Promise<OwnerGone>;
  /** Resolves when the worker and every other member of its group have ended. */
  readonly result: Promise<OwnedWorkerResult>;
}

/**
 * Starts one worker and ties its life to the owner: when the owner is gone (graceful or abrupt,
 * see `OwnerGoneReason`) the worker's process group is interrupted, and killed after
 * `worker.graceMs` if it is still alive. Only the group created for this worker is ever
 * signalled; no other process or group is looked up, matched or killed (ADR-0028).
 *
 * The owner watch is installed before the worker is spawned, so an owner that vanishes during
 * start is still handled. Files in the worker's `cwd` are never touched: stopping is a signal, not
 * a cleanup.
 */
export async function runWorkerUnderOwner(options: OwnedWorkerRunOptions): Promise<OwnedWorkerRun> {
  const watch = watchOwnerLiveness(options.owner);
  let worker: SupervisedProcess;
  try {
    worker = await startSupervisedProcess(options.worker);
  } catch (error) {
    watch.dispose();
    throw error;
  }

  let ownerGone: OwnerGone | null = null;
  void watch.gone.then((gone) => {
    ownerGone = gone;
    worker.cancel("SIGINT", "group");
  });
  const result = worker.exit.then((workerExit): OwnedWorkerResult => {
    watch.dispose();
    return { ownerGone, workerExit };
  });
  return { worker, ownerGone: watch.gone, result };
}
