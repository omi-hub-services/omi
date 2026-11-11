// Terminal worker/quota watch (OMI-064, ADR-0014). No automatic paid probes.
import { emitKeypressEvents } from "node:readline";
import { parseArgs } from "node:util";
import {
  QUOTA_SETTINGS,
  WORKER_PROFILES,
  wslTarget,
  type QuotaSettings,
  type WorkerProfile,
  type WslTarget,
} from "./coordinator-settings.ts";
import { createProcessRunner, type Runner } from "./process-runner.ts";
import { localTime, modelLeftText, windowLeft, type QuotaReport } from "./quota.ts";
import {
  clean,
  createWatchPoller,
  STALE_AFTER_SECONDS,
  windowsLow,
  workerTone,
} from "./watch-core.ts";
import type { Workers } from "./wsl-workers.ts";

export const ANSI = {
  clear: "\x1b[2J\x1b[H",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  reset: "\x1b[0m",
  grey: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
} as const;

const paint = (s: string, colour: string) => (colour ? `${colour}${s}${ANSI.reset}` : s);
const value = (s: string | null | undefined) => clean(s ?? "-");

function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s >= 3600
    ? `${String(Math.floor(s / 3600))}h${String(Math.floor((s % 3600) / 60))}m`
    : s >= 60
      ? `${String(Math.floor(s / 60))}m${String(s % 60)}s`
      : `${String(s)}s`;
}

export interface WatchScreen {
  readonly workers: Workers | null;
  readonly quota: QuotaReport | null;
  readonly now: number;
  readonly settings: QuotaSettings;
  readonly profiles: readonly WorkerProfile[];
  readonly confirming?: boolean;
  readonly probing?: boolean;
  readonly columns?: number;
}

/** Pure: all data, current time, settings and terminal width are explicit inputs. */
export function renderWatch(screen: WatchScreen): string {
  const width = Math.max(20, screen.columns ?? 160);
  const fit = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);
  const out = ["Workers"];
  const workers = screen.workers;
  if (!workers) out.push("  Loading…");
  else if (!workers.available)
    out.push(paint(fit(`  WSL unavailable: ${clean(workers.reason)} (retrying)`), ANSI.red));
  else {
    if (workers.processes.length === 0) out.push("  (none)");
    for (const p of workers.processes) {
      const tone = workerTone(p.log);
      const colour = tone === "error" ? ANSI.red : tone === "done" ? ANSI.grey : "";
      out.push(
        paint(
          fit(
            `${value(p.task)}  ${p.tool} ${value(p.profile)}  ${value(p.model)} ${value(p.effort)}  pid ${String(p.pid)}  ${duration(p.elapsedSeconds)}  turn ${p.log ? String(p.log.numTurns) : "?"}  → ${value(p.log?.lastAction)}`,
          ),
          colour,
        ),
      );
    }
  }
  out.push("", fit("Quota — left 5h / 7d · reset 5h · age"));
  const quota = screen.quota;
  if (quota && !quota.available)
    out.push(paint(fit(`  WSL unavailable: ${clean(quota.reason)} (retrying)`), ANSI.red));
  for (const profile of screen.profiles) {
    const p = quota?.available
      ? quota.profiles.find((p) => p.tool === profile.tool && p.profile === profile.profile)
      : null;
    const r = p?.reading;
    if (!r) {
      out.push(
        fit(
          `  ${profile.tool} ${clean(profile.profile)}  ? / ?  reset ?  age ? (${clean(p?.note ?? (quota ? "unavailable" : "loading"))})`,
        ),
      );
      continue;
    }
    const left5 = windowLeft(r.fiveHour, screen.now);
    const left7 = windowLeft(r.sevenDay, screen.now);
    const percent = (n: number | null) =>
      n === null ? "?" : `${String(Math.round(n * 10) / 10)}%`;
    const low = windowsLow(left5, left7, screen.settings);
    const ageSeconds = Math.max(0, screen.now - r.observedAt);
    const scoped = modelLeftText(r, screen.now).map(clean);
    const models = scoped.length > 0 ? `  ${scoped.join(" ")}` : "";
    const age = ageSeconds < 60 ? "live" : `${String(Math.floor(ageSeconds / 60))} min ago`;
    const reset = r.fiveHour?.resetsAt;
    const resetDate = reset === null || reset === undefined ? null : new Date(reset * 1000);
    const resetText =
      resetDate && Number.isFinite(resetDate.getTime())
        ? localTime(resetDate.getTime() / 1000).slice(11, 16)
        : "?";
    out.push(
      paint(
        fit(
          `  ${profile.tool} ${clean(profile.profile)}  ${percent(left5)} / ${percent(left7)}${models}  reset ${resetText}  ${age}`,
        ),
        `${low ? ANSI.yellow : ""}${ageSeconds > STALE_AFTER_SECONDS ? ANSI.dim : ""}`,
      ),
    );
  }
  out.push(
    "",
    fit(
      screen.confirming
        ? "Probe Claude quota? One Haiku call per Claude profile. y/N"
        : screen.probing
          ? "Probing quota…  q quit"
          : "p probe quota (confirmation required) · q quit",
    ),
  );
  return `${ANSI.clear}${out.join("\n")}\n`;
}

export function watchInterval(args: readonly string[]): number {
  const { values } = parseArgs({
    args: [...args],
    options: { interval: { type: "string", default: "5" } },
  });
  const seconds = Number(values.interval);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 2147483) {
    throw new Error("--interval must be positive seconds (at most 2147483)");
  }
  return Math.max(1, Math.round(seconds * 1000));
}

export interface WatchTerminal {
  write(text: string): void;
  setRawMode(enabled: boolean): void;
  onKey(listener: (key: string) => void): () => void;
  columns(): number;
}

export interface WatchOptions {
  readonly run: Runner;
  readonly target: WslTarget;
  readonly terminal: WatchTerminal;
  readonly intervalMs: number;
  readonly profiles: readonly WorkerProfile[];
  readonly settings: QuotaSettings;
  readonly signal?: AbortSignal;
}

/** Polling lives in watch-core.ts; this wires it to a terminal. */
export function runWatch(options: WatchOptions): Promise<void> {
  return new Promise((resolve) => {
    const { terminal, target, profiles, settings } = options;
    let stopped = false;
    let confirming = false;
    const draw = () => {
      if (!stopped)
        terminal.write(
          renderWatch({
            workers: poller.workers,
            quota: poller.quota,
            confirming,
            probing: poller.probing,
            now: Date.now() / 1000,
            settings,
            profiles,
            columns: terminal.columns(),
          }),
        );
    };
    const poller = createWatchPoller({
      run: options.run,
      target,
      profiles,
      settings,
      workerIntervalMs: options.intervalMs,
      onChange: draw,
    });
    const ageTimer = setInterval(draw, 1000);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(ageTimer);
      poller.stop();
      removeKey();
      options.signal?.removeEventListener("abort", stop);
      terminal.setRawMode(false);
      terminal.write(`${ANSI.reset}${ANSI.show}\n`);
      resolve();
    };
    const removeKey = terminal.onKey((key) => {
      if (key === "q" || key === "\u0003") {
        stop();
        return;
      }
      if (confirming) {
        confirming = false;
        if (key.toLowerCase() === "y") poller.probe();
      } else if (key === "p" && !poller.probing && !poller.probeQueued) confirming = true;
      draw();
    });
    options.signal?.addEventListener("abort", stop, { once: true });
    terminal.setRawMode(true);
    terminal.write(ANSI.hide);
    draw();
    if (options.signal?.aborted) {
      stop();
      return;
    }
    poller.start();
  });
}

async function main(): Promise<void> {
  const intervalMs = watchInterval(process.argv.slice(2));
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("watch requires an interactive terminal");
  const signal = new AbortController();
  const stop = () => {
    signal.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  try {
    await runWatch({
      run: createProcessRunner(),
      target: wslTarget(),
      profiles: WORKER_PROFILES,
      settings: QUOTA_SETTINGS,
      intervalMs,
      signal: signal.signal,
      terminal: {
        write: (text) => {
          process.stdout.write(text);
        },
        setRawMode: (enabled) => {
          process.stdin.setRawMode(enabled);
        },
        columns: () => process.stdout.columns,
        onKey: (listener) => {
          const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
            listener(key.ctrl && key.name === "c" ? "\u0003" : (text ?? key.name ?? ""));
          };
          process.stdin.on("keypress", onKey);
          process.stdin.resume();
          return () => {
            process.stdin.off("keypress", onKey);
            process.stdin.pause();
          };
        },
      },
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.setRawMode(wasRaw);
    process.stdout.write(`${ANSI.reset}${ANSI.show}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`watch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
