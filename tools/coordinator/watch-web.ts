// Web watch (OMI-067, OMI-092, ADR-0014): /omi-watch serves the framework's one watch page
// (src/infrastructure/observability) from a localhost server, opened as a small Edge --app window.
// The framework server owns the guards (127.0.0.1 only, Host/Origin checks against DNS rebinding,
// CSP, GET-only /, /health and /events, no control endpoint); this file only reads the repo's
// sources (GitHub board, WSL workers and prompts, quota) and maps them into the shared snapshot.
// Exits after 60 s with no SSE client. Data comes from the same reads as the terminal watch.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { parseArgs } from "node:util";
import type { WatchSnapshot } from "../../src/application/contracts/watch-snapshot.ts";
import "../register-ts-imports.ts";
import {
  QUOTA_SETTINGS,
  WORKER_PROFILES,
  wslTarget,
  type QuotaSettings,
  type WorkerProfile,
  type WslTarget,
} from "./coordinator-settings.ts";
import { createProcessRunner, type Runner } from "./process-runner.ts";
import { clean, createWatchPoller, TASKS_INTERVAL_MS } from "./watch-core.ts";
import { buildSnapshot } from "./watch-snapshot.ts";
import { readTasks, type TasksRead } from "./watch-tasks.ts";

// dynamic: the register hook above must run before src/ (`.js` specifiers) is resolved
const { createWatchServer: createSharedServer, HEALTH_BODY: SHARED_HEALTH_BODY } =
  await import("../../src/infrastructure/observability/watch-server.ts");

export const DEFAULT_PORT = 4317;
export const IDLE_MS = 60_000;
/** Wide and tall enough for the lifecycle diagram of two or three task cards (OMI-074). */
export const WINDOW_SIZE = "560,760";
/** `GET /health` answers this so a second launch can reuse the running server. */
export const HEALTH_BODY: string = SHARED_HEALTH_BODY;

export interface WatchServerOptions {
  readonly run: Runner;
  readonly target: WslTarget;
  readonly profiles: readonly WorkerProfile[];
  readonly settings: QuotaSettings;
  /** 0 picks a free port. */
  readonly port: number;
  readonly workerIntervalMs?: number;
  readonly quotaIntervalMs?: number;
  readonly tasksIntervalMs?: number;
  /** How often connected pages get a fresh snapshot; the sources are polled on their own timers. */
  readonly pushIntervalMs?: number;
  /** No SSE client for this long (from the last disconnect, or from start) stops the server. */
  readonly idleMs?: number;
  /** Unix milliseconds. */
  readonly clock?: () => number;
  /** Called once after an idle shutdown has closed the server. */
  readonly onIdle?: () => void;
}

export interface WatchServer {
  /** Resolves with the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createWatchServer(options: WatchServerOptions): WatchServer {
  const clock = options.clock ?? Date.now;
  let lastGood: Extract<TasksRead, { available: true }> | null = null;

  // GitHub trouble keeps the last good cards and flags the board, instead of emptying the page.
  const readSnapshot = (): Promise<WatchSnapshot> => {
    const tasks = poller.tasks;
    if (tasks?.available) lastGood = tasks;
    const retained = tasks?.available === false && lastGood !== null;
    const snapshot = buildSnapshot({
      workers: poller.workers,
      tasks: retained ? lastGood : tasks,
      quota: poller.quota,
      now: clock() / 1000,
      settings: options.settings,
      profiles: options.profiles,
    });
    return Promise.resolve(retained ? { ...snapshot, board: "unavailable" } : snapshot);
  };
  const poller = createWatchPoller({
    run: options.run,
    target: options.target,
    profiles: options.profiles,
    settings: options.settings,
    workerIntervalMs: options.workerIntervalMs ?? 5000,
    ...(options.quotaIntervalMs === undefined ? {} : { quotaIntervalMs: options.quotaIntervalMs }),
    tasks: {
      intervalMs: options.tasksIntervalMs ?? TASKS_INTERVAL_MS,
      read: (run, workers) => readTasks(run, options.target, workers),
    },
    onChange: () => {},
    onError: (error) => {
      console.error(`watch-web: ${clean(error instanceof Error ? error.message : String(error))}`);
    },
  });
  const shared = createSharedServer({
    readSnapshot,
    port: options.port,
    intervalMs: options.pushIntervalMs ?? 2000,
    idleMs: options.idleMs ?? IDLE_MS,
    onIdle: () => {
      poller.stop();
      options.onIdle?.();
    },
  });
  return {
    async listen() {
      const { port } = await shared.listen();
      poller.start();
      return port;
    },
    async close() {
      poller.stop();
      await shared.close();
    },
  };
}

// ── --open ───────────────────────────────────────────────────────────────────

/** True when an omi-watch server already answers on the port. */
export function isWatchRunning(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          if (body.length < 64) body += d;
        });
        res.on("end", () => {
          resolve(res.statusCode === 200 && body.trim() === HEALTH_BODY);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => {
      resolve(false);
    });
    req.end();
  });
}

export interface Launch {
  readonly file: string;
  readonly args: readonly string[];
}

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/**
 * Launch candidates in order: Edge as an app window, then the default browser. `edgePaths` are the
 * Edge installs that exist on this machine (Windows keeps msedge off PATH).
 */
export function openCandidates(
  url: string,
  platform: NodeJS.Platform,
  edgePaths: readonly string[],
): Launch[] {
  const edgeArgs = [`--app=${url}`, `--window-size=${WINDOW_SIZE}`];
  // Windows often returns ENOENT for msedge on PATH; try its installed paths next.
  const edge: Launch[] = [
    { file: "msedge", args: edgeArgs },
    ...edgePaths.map((file) => ({ file, args: edgeArgs })),
  ];
  // `start "" <url>` opens the default browser; the empty string is the window title.
  const defaultBrowser: Launch =
    platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "cmd.exe", args: ["/c", "start", "", url] };
  return [
    ...edge,
    defaultBrowser,
    ...(platform === "win32" ? [] : [{ file: "xdg-open", args: [url] }]),
  ];
}

export type Spawner = (launch: Launch) => Promise<boolean>;

const detachedSpawn: Spawner = (launch) =>
  new Promise((resolve) => {
    try {
      const child = spawn(launch.file, [...launch.args], { stdio: "ignore", detached: true });
      child.once("error", () => {
        resolve(false);
      });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

/** Opens the page; returns the launch that started, or null when nothing could be started. */
export async function openWindow(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawner: Spawner = detachedSpawn,
  exists: (path: string) => boolean = existsSync,
): Promise<Launch | null> {
  const edgePaths = platform === "win32" ? EDGE_PATHS.filter(exists) : [];
  for (const launch of openCandidates(url, platform, edgePaths)) {
    if (await spawner(launch)) return launch;
  }
  return null;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseWatchWebArgs(args: readonly string[]): { port: number; open: boolean } {
  const { values } = parseArgs({
    args: [...args],
    options: { port: { type: "string", default: String(DEFAULT_PORT) }, open: { type: "boolean" } },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port must be an integer from 1 to 65535");
  return { port, open: values.open === true };
}

async function main(): Promise<void> {
  const { port, open } = parseWatchWebArgs(process.argv.slice(2));
  const url = `http://127.0.0.1:${String(port)}`;
  const launch = async () => {
    if (!open) return;
    const started = await openWindow(url);
    console.log(started ? `opened ${started.file}` : `could not open a window; visit ${url}`);
  };
  if (await isWatchRunning(port)) {
    console.log(`omi-watch already running at ${url}`);
    await launch();
    return;
  }
  const server = createWatchServer({
    run: createProcessRunner(),
    target: wslTarget(),
    profiles: WORKER_PROFILES,
    settings: QUOTA_SETTINGS,
    port,
  });
  const stop = () => {
    void server.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await server.listen();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "EADDRINUSE" ? `port ${String(port)} is in use by another program` : String(error),
      { cause: error },
    );
  }
  console.log(
    `omi-watch listening at ${url} (exits after ${String(IDLE_MS / 1000)}s with no window)`,
  );
  await launch();
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`watch-web: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
