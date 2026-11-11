// Web watch (OMI-067, ADR-0014): a localhost page with live workers and quota, opened as a small
// Edge --app window by /omi-watch. Binds 127.0.0.1 only, rejects a foreign Host or Origin (DNS
// rebinding) and runs a paid probe only for POST /probe with `X-Omi-Watch: 1`. Exits after
// 60 s with no SSE client. Data comes from the same reads as the terminal watch.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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
import { clean, createWatchPoller } from "./watch-core.ts";
import { PAGE_CSP, PAGE_HTML } from "./watch-page.ts";
import { buildSnapshot } from "./watch-snapshot.ts";

export const DEFAULT_PORT = 4317;
export const IDLE_MS = 60_000;
export const WINDOW_SIZE = "440,460";
/** `GET /health` answers this so a second launch can reuse the running server. */
export const HEALTH_BODY = "omi-watch";
export const PROBE_HEADER = "x-omi-watch";

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface WatchServerOptions {
  readonly run: Runner;
  readonly target: WslTarget;
  readonly profiles: readonly WorkerProfile[];
  readonly settings: QuotaSettings;
  /** 0 picks a free port. */
  readonly port: number;
  readonly workerIntervalMs?: number;
  readonly quotaIntervalMs?: number;
  /** No SSE client for this long (from the last disconnect, or from start) stops the server. */
  readonly idleMs?: number;
  /** Injected in tests to fire the idle timeout without waiting. */
  readonly scheduler?: Scheduler;
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
  const scheduler = options.scheduler ?? realScheduler;
  const clock = options.clock ?? Date.now;
  const clients = new Set<ServerResponse>();
  let port = options.port;
  let idleHandle: unknown = null;
  let closing: Promise<void> | null = null;
  let keepAlive: NodeJS.Timeout | null = null;

  const snapshotJson = () =>
    JSON.stringify(
      buildSnapshot({
        workers: poller.workers,
        quota: poller.quota,
        probing: poller.probing,
        now: clock() / 1000,
        settings: options.settings,
        profiles: options.profiles,
      }),
    );
  const broadcast = () => {
    if (clients.size === 0) return;
    const frame = `data: ${snapshotJson()}\n\n`;
    for (const res of clients) res.write(frame);
  };
  const poller = createWatchPoller({
    run: options.run,
    target: options.target,
    profiles: options.profiles,
    settings: options.settings,
    workerIntervalMs: options.workerIntervalMs ?? 5000,
    ...(options.quotaIntervalMs === undefined ? {} : { quotaIntervalMs: options.quotaIntervalMs }),
    onChange: broadcast,
    onError: (error) => {
      console.error(`watch-web: ${clean(error instanceof Error ? error.message : String(error))}`);
    },
  });

  const armIdle = () => {
    if (idleHandle !== null) scheduler.clear(idleHandle);
    idleHandle = scheduler.set(() => {
      idleHandle = null;
      void close().then(() => options.onIdle?.());
    }, options.idleMs ?? IDLE_MS);
  };
  const disarmIdle = () => {
    if (idleHandle !== null) scheduler.clear(idleHandle);
    idleHandle = null;
  };

  const reply = (res: ServerResponse, status: number, body: string, type = "text/plain") => {
    res.writeHead(status, {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  };

  const events = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    res.write(`retry: 2000\n\ndata: ${snapshotJson()}\n\n`);
    clients.add(res);
    disarmIdle();
    req.on("close", () => {
      clients.delete(res);
      if (clients.size === 0 && !closing) armIdle();
    });
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const allowed = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
    const host = req.headers.host?.toLowerCase();
    if (host === undefined || !allowed.includes(host)) {
      reply(res, 403, "forbidden host");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.some((h) => origin.toLowerCase() === `http://${h}`)) {
      reply(res, 403, "forbidden origin");
      return;
    }

    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const methods: Record<string, string> = {
      "/": "GET",
      "/health": "GET",
      "/events": "GET",
      "/probe": "POST",
    };
    const method = methods[path];
    if (method === undefined) {
      reply(res, 404, "not found");
      return;
    }
    if (req.method !== method) {
      res.setHeader("Allow", method);
      reply(res, 405, "method not allowed");
      return;
    }
    if (path === "/") {
      res.setHeader("Content-Security-Policy", PAGE_CSP);
      res.setHeader("Referrer-Policy", "no-referrer");
      reply(res, 200, PAGE_HTML, "text/html");
    } else if (path === "/health") {
      reply(res, 200, HEALTH_BODY);
    } else if (path === "/events") {
      events(req, res);
    } else if (req.headers[PROBE_HEADER] !== "1") {
      req.resume();
      reply(res, 403, "missing X-Omi-Watch header");
    } else {
      req.resume();
      poller.probe();
      reply(res, 202, "probe started");
    }
  };

  const server = createServer(handle);

  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      disarmIdle();
      if (keepAlive) clearInterval(keepAlive);
      poller.stop();
      for (const res of clients) res.end();
      clients.clear();
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
    return closing;
  }

  return {
    listen() {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, "127.0.0.1", () => {
          server.off("error", reject);
          port = (server.address() as AddressInfo).port;
          poller.start();
          armIdle();
          keepAlive = setInterval(() => {
            for (const res of clients) res.write(": ping\n\n");
          }, 15_000);
          keepAlive.unref();
          resolve(port);
        });
      });
    },
    close,
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
