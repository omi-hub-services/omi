import type { ProjectSession } from "../../application/ports/lease-store.js";
import { watchOwnerLiveness, type OwnerLivenessOptions, type OwnerGone } from "./owner-liveness.js";
import {
  startSupervisedProcess,
  type SupervisedProcess,
  type SupervisedProcessOptions,
} from "./supervised-process.js";
import { SESSION_HEARTBEAT_PERIOD_MS, SESSION_WORKER_GRACE_MS } from "./session-timing.js";
import { startResourceWakeupLoop, type ResourceWakeupOptions } from "./resource-wakeup-loop.js";

/** Process ownership only; dispatch policy and recovery are separate use cases. */
export async function startSessionRuntime(options: {
  session: ProjectSession;
  owner: OwnerLivenessOptions;
  startAccepting(): Promise<void>;
  stopAccepting(): Promise<void>;
  afterWorkersStopped?(): Promise<void>;
  renewPeriodMs?: number;
  resourceWakeup?(canDispatch: () => boolean): ResourceWakeupOptions | undefined;
}) {
  const watch = watchOwnerLiveness(options.owner);
  const workers = new Set<Promise<SupervisedProcess>>();
  let accepting = false;
  const lifecycle = { stopping: false };
  let resolveStop: (reason: OwnerGone | { reason: "lease-lost" | "startup-failed" }) => void = () =>
    undefined;
  const stop = new Promise<OwnerGone | { reason: "lease-lost" | "startup-failed" }>((resolve) => {
    resolveStop = resolve;
  });
  const requestStop = (reason: OwnerGone | { reason: "lease-lost" | "startup-failed" }) => {
    accepting = false;
    lifecycle.stopping = true;
    resolveStop(reason);
  };
  void watch.gone.then(requestStop);
  const renewal = setInterval(() => {
    try {
      if (!options.session.renew()) requestStop({ reason: "lease-lost" });
    } catch {
      requestStop({ reason: "lease-lost" });
    }
  }, options.renewPeriodMs ?? SESSION_HEARTBEAT_PERIOD_MS);

  const startWorker = async (
    worker: Omit<SupervisedProcessOptions, "graceMs"> & { graceMs?: number },
  ) => {
    if (!accepting) throw new Error("SESSION_NOT_ACCEPTING");
    try {
      if (!options.session.renew()) throw new Error("LEASE_LOST");
    } catch {
      requestStop({ reason: "lease-lost" });
      throw new Error("SESSION_NOT_ACCEPTING");
    }
    const pending = startSupervisedProcess({
      ...worker,
      graceMs: worker.graceMs ?? SESSION_WORKER_GRACE_MS,
    });
    workers.add(pending);
    try {
      const handle = await pending;
      if (lifecycle.stopping) handle.cancel("SIGINT", "group");
      void handle.exit.then(() => workers.delete(pending));
      return handle;
    } catch (error) {
      workers.delete(pending);
      throw error;
    }
  };
  let startupError: Error | undefined;
  let resourceWakeup: ReturnType<typeof startResourceWakeupLoop> | undefined;
  try {
    options.session.record("session.started", { startedAt: options.session.lease.acquiredAt });
    await options.startAccepting();
    if (!lifecycle.stopping) {
      accepting = true;
      const wakeupOptions = options.resourceWakeup?.(() => accepting);
      if (wakeupOptions !== undefined) resourceWakeup = startResourceWakeupLoop(wakeupOptions);
    }
  } catch (error) {
    startupError = error instanceof Error ? error : new Error("runtime startup failed");
    requestStop({ reason: "startup-failed" });
  }
  const result = (async () => {
    const reason = await stop;
    let stopError: Error | undefined;
    const wakeupStopped = resourceWakeup?.stop();
    try {
      await options.stopAccepting();
    } catch (error) {
      stopError = error instanceof Error ? error : new Error("runtime admission stop failed");
    }
    // Include spawns in flight; no worker can escape the stop snapshot during spawn.
    const owned = await Promise.allSettled([...workers]);
    const handles = owned.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
    for (const worker of handles) worker.cancel("SIGINT", "group");
    const exits = await Promise.all(
      handles.map(async (worker) => {
        const exit = await worker.exit;
        return {
          pid: worker.pid,
          exitCode: exit.exitCode,
          signal: exit.signal,
          escalated: exit.escalated,
          leftoverProcessesKilled: exit.leftoverProcessesKilled,
        };
      }),
    );
    try {
      await wakeupStopped;
      await options.afterWorkersStopped?.();
      options.session.record("session.interrupted", { reason: reason.reason, workers: exits });
      options.session.release();
    } finally {
      clearInterval(renewal);
      watch.dispose();
    }
    if (startupError !== undefined) throw startupError;
    if (stopError !== undefined) throw stopError;
    return { reason, workers: exits };
  })();
  return {
    startWorker,
    result,
    get accepting() {
      return accepting;
    },
  };
}
