// Logic shared by the terminal watch (watch.ts) and the web watch (watch-web.ts): the colour
// rules, text cleaning and the non-overlapping worker/quota poller (OMI-064, OMI-067, ADR-0014).
import {
  QUOTA_MIN_INTERVAL_MS,
  type QuotaSettings,
  type WorkerProfile,
  type WslTarget,
} from "./coordinator-settings.ts";
import type { Runner } from "./process-runner.ts";
import { localTime, readQuota, type QuotaReport } from "./quota.ts";
import type { TasksRead } from "./watch-tasks.ts";
import { readWorkers, type WorkerLogSummary, type Workers } from "./wsl-workers.ts";

/** GitHub (Project items, PRs, comments) is read this often; workers every 5 s (OMI-074). */
export const TASKS_INTERVAL_MS = 60_000;

/** A quota reading older than this is shown dim. */
export const STALE_AFTER_SECONDS = 1800;

/** Strip control characters from external text and collapse whitespace. */
export const clean = (s: string) =>
  s
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export type Tone = "normal" | "done" | "error";

/** Errors and rate limits are red, finished workers grey, anything else plain. */
export function workerTone(log: WorkerLogSummary | null | undefined): Tone {
  return log?.isError || log?.limited ? "error" : log?.finished ? "done" : "normal";
}

/** Either window below its pick-profile threshold. A null window never counts as low. */
export function windowsLow(
  left5: number | null,
  left7: number | null,
  settings: QuotaSettings,
): boolean {
  return (
    (left5 !== null && left5 < settings.minFiveHourLeftPercent) ||
    (left7 !== null && left7 < settings.minSevenDayLeftPercent)
  );
}

/** Shared reset display: elapsed windows have no pending reset time. */
export function resetText(resetsAt: number | null | undefined, now: number, clockOnly: boolean) {
  if (resetsAt == null || !Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const local = localTime(resetsAt);
  return clockOnly ? local.slice(11, 16) : local.slice(5, 16);
}

export interface WatchPollerOptions {
  readonly run: Runner;
  readonly target: WslTarget;
  readonly profiles: readonly WorkerProfile[];
  readonly settings: QuotaSettings;
  readonly workerIntervalMs: number;
  readonly quotaIntervalMs?: number;
  /** Opt-in GitHub/prompt read for the Tasks view (OMI-074); runs on the injected runner. */
  readonly tasks?: {
    readonly intervalMs: number;
    readonly read: (run: Runner) => Promise<TasksRead>;
  };
  /** Called after every refresh and when a probe starts; never after `stop`. */
  readonly onChange: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface WatchPoller {
  readonly workers: Workers | null;
  /** null until the first Tasks read (always null when the poller has no `tasks` option). */
  readonly tasks: TasksRead | null;
  readonly quota: QuotaReport | null;
  readonly probing: boolean;
  readonly probeQueued: boolean;
  start(): void;
  /** Paid probe (one Haiku call per Claude profile); queued while a read is in flight. */
  probe(): void;
  stop(): void;
}

/**
 * Independent, non-overlapping polls keep quota latency out of the worker refresh path. No paid
 * probe ever runs unless `probe()` is called.
 */
export function createWatchPoller(options: WatchPollerOptions): WatchPoller {
  const { target, profiles, settings, onChange } = options;
  const controller = new AbortController();
  const run: Runner = (command) => options.run({ ...command, signal: controller.signal });
  let stopped = false;
  let started = false;
  let workers: Workers | null = null;
  let quota: QuotaReport | null = null;
  let tasks: TasksRead | null = null;
  let probing = false;
  let workerBusy = false;
  let tasksBusy = false;
  let quotaBusy = false;
  let probeQueued = false;
  let timers: NodeJS.Timeout[] = [];
  const notify = () => {
    if (!stopped) onChange();
  };
  const reportError = (error: unknown) => {
    if (!stopped) options.onError?.(error);
  };
  const refreshWorkers = async () => {
    if (workerBusy || stopped) return;
    workerBusy = true;
    try {
      workers = await readWorkers(run, target);
      notify();
    } finally {
      workerBusy = false;
    }
  };
  const refreshTasks = async () => {
    if (tasksBusy || stopped || !options.tasks) return;
    tasksBusy = true;
    try {
      tasks = await options.tasks.read(run);
      notify();
    } finally {
      tasksBusy = false;
    }
  };
  const refreshQuota = async (probe = false): Promise<void> => {
    if (stopped) return;
    if (quotaBusy) {
      probeQueued ||= probe;
      return;
    }
    quotaBusy = true;
    probing = probe;
    try {
      notify();
      quota = await readQuota(run, target, profiles, settings, probe);
    } finally {
      quotaBusy = false;
      probing = false;
    }
    notify();
    if (probeQueued) {
      probeQueued = false;
      await refreshQuota(true);
    }
  };
  return {
    get workers() {
      return workers;
    },
    get tasks() {
      return tasks;
    },
    get quota() {
      return quota;
    },
    get probing() {
      return probing;
    },
    get probeQueued() {
      return probeQueued;
    },
    start() {
      if (started || stopped) return;
      started = true;
      timers = [
        setInterval(() => {
          void refreshWorkers().catch(reportError);
        }, options.workerIntervalMs),
        setInterval(
          () => {
            void refreshQuota().catch(reportError);
          },
          Math.max(options.quotaIntervalMs ?? QUOTA_MIN_INTERVAL_MS, QUOTA_MIN_INTERVAL_MS),
        ),
      ];
      if (options.tasks) {
        timers.push(
          setInterval(() => {
            void refreshTasks().catch(reportError);
          }, options.tasks.intervalMs),
        );
        void refreshTasks().catch(reportError);
      }
      void refreshWorkers().catch(reportError);
      void refreshQuota().catch(reportError);
    },
    probe() {
      probeQueued = false;
      void refreshQuota(true).catch(reportError);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const t of timers) clearInterval(t);
      controller.abort();
    },
  };
}
