import { backoffDelayMs } from "../../domain/runs/retry-policy.js";

export interface ResourceWakeupTimer {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface ResourceWakeupOptions {
  readonly tick: () => Promise<number>;
  readonly timing: { readonly interval_ms: number; readonly max_backoff_ms: number };
  readonly timer?: ResourceWakeupTimer;
  readonly jitter?: () => number;
}

/** A single in-flight pass; stopping cancels scheduling and drains it before session release. */
export function startResourceWakeupLoop(options: ResourceWakeupOptions) {
  const timer = options.timer ?? {
    schedule(callback: () => void, delayMs: number) {
      const handle = setTimeout(callback, delayMs);
      return () => {
        clearTimeout(handle);
      };
    },
  };
  let stopped = false;
  let idlePasses = 0;
  let pending: Promise<void> = Promise.resolve();
  let cancel: () => void = () => undefined;
  const schedule = (delayMs: number) => {
    cancel = timer.schedule(() => {
      if (stopped) return;
      pending = tick();
    }, delayMs);
  };
  const tick = async () => {
    let dispatched = 0;
    try {
      dispatched = await options.tick();
    } catch {
      // A failed pass retains durable state and uses the same bounded retry delay.
    }
    idlePasses = dispatched > 0 ? 0 : Math.min(idlePasses + 1, 32);
    if (!stopped)
      schedule(
        Math.max(
          options.timing.interval_ms,
          backoffDelayMs(idlePasses, options.jitter?.() ?? Math.random(), {
            maxAttempts: 0,
            baseDelayMs: options.timing.interval_ms,
            maxDelayMs: options.timing.max_backoff_ms,
          }),
        ),
      );
  };
  schedule(options.timing.interval_ms);
  return {
    async stop() {
      stopped = true;
      cancel();
      await pending;
    },
  };
}
