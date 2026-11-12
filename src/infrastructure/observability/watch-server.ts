import { createServer, type ServerResponse } from "node:http";
import type { WatchSnapshot } from "../../application/contracts/watch-snapshot.js";
import { PAGE_CSP, PAGE_HTML } from "./watch-page.js";

export const HEALTH_BODY = "omi-watch";
export interface WatchServer {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

/** A read-only loopback view. Slow SSE clients are disconnected rather than buffered forever. */
export function createWatchServer(options: {
  readSnapshot: () => Promise<WatchSnapshot>;
  port?: number;
  intervalMs?: number;
  idleMs?: number;
  onIdle?: () => void;
}): WatchServer {
  const clients = new Set<ServerResponse>();
  let port = 0;
  let started = false;
  let stopped = false;
  let polling = false;
  let frame: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    stopped = true;
    clearInterval(timer);
    clearTimeout(idle);
    for (const client of clients) client.destroy();
    clients.clear();
    closing = new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
      server.closeAllConnections();
    });
    return closing;
  };
  const armIdle = () => {
    clearTimeout(idle);
    if (!stopped && clients.size === 0)
      idle = setTimeout(() => {
        void close().then(() => options.onIdle?.());
      }, options.idleMs ?? 60_000);
  };
  const send = (client: ServerResponse, data: string) => {
    if (!client.write(`data: ${data}\n\n`)) client.destroy();
  };
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    let next: string;
    try {
      next = JSON.stringify({ state: "ok", snapshot: await options.readSnapshot() });
    } catch {
      next = JSON.stringify({ state: "unavailable", reason: "SNAPSHOT_FAILED" });
    }
    polling = false;
    if (isStopped() || next === frame) return;
    frame = next;
    for (const client of clients) send(client, next);
  };
  const isStopped = () => stopped;
  const server = createServer((req, res) => {
    const reply = (status: number, body: string, type = "text/plain") => {
      res.writeHead(status, {
        "Content-Type": `${type}; charset=utf-8`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": PAGE_CSP,
        ...(status === 405 ? { Allow: "GET" } : {}),
      });
      res.end(body);
    };
    const hosts = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
    if (!hosts.includes(req.headers.host ?? "")) {
      reply(403, "forbidden host");
      return;
    }
    if (
      req.headers.origin !== undefined &&
      !hosts.map((host) => `http://${host}`).includes(req.headers.origin)
    ) {
      reply(403, "forbidden origin");
      return;
    }
    if (!["/", "/health", "/events"].includes(req.url ?? "")) {
      reply(404, "not found");
      return;
    }
    if (req.method !== "GET") {
      reply(405, "method not allowed");
      return;
    }
    if (req.url === "/health") {
      reply(200, HEALTH_BODY);
      return;
    }
    if (req.url === "/") {
      reply(200, PAGE_HTML, "text/html");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    clients.add(res);
    clearTimeout(idle);
    if (timer === undefined)
      timer = setInterval(() => {
        void poll();
      }, options.intervalMs ?? 5000);
    res.on("close", () => {
      clients.delete(res);
      armIdle();
    });
    if (frame !== undefined) send(res, frame);
    else void poll();
  });
  return {
    close,
    async listen() {
      if (started || stopped) throw new Error("WATCH_ALREADY_STARTED");
      started = true;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 4381, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("WATCH_NO_ADDRESS");
      port = address.port;
      armIdle();
      return { port };
    },
  };
}
