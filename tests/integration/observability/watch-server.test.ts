import { createHash } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { WatchSnapshot } from "../../../src/application/use-cases/project/read-watch-snapshot.ts";
import {
  createWatchServer,
  HEALTH_BODY,
  type WatchServer,
} from "../../../src/infrastructure/observability/watch-server.ts";

const snapshot = (generatedAt = "2026-11-12T10:00:00.000Z"): WatchSnapshot => ({
  schemaVersion: 1,
  generatedAt,
  board: "ok",
  tasks: [],
  quota: { state: "not-configured", reason: null, rows: [] },
});

const open: WatchServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

async function start(
  options: Partial<Parameters<typeof createWatchServer>[0]> = {},
): Promise<{ port: number; server: WatchServer }> {
  const server = createWatchServer({
    readSnapshot: () => Promise.resolve(snapshot()),
    port: 0, // ephemeral: the tests never use the default port
    intervalMs: 10_000,
    idleMs: 60_000,
    ...options,
  });
  open.push(server);
  const { port } = await server.listen();
  return { port, server };
}

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}
/** `fetch` cannot set Host, and the Host check is the point, so this uses node:http. */
function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Opens `/events` and hands out the `data:` frames as they arrive. */
function events(port: number, headers: Record<string, string> = {}) {
  const frames: unknown[] = [];
  const waiting: ((frame: unknown) => void)[] = [];
  let response: IncomingMessage | undefined;
  const req = request({ host: "127.0.0.1", port, path: "/events", headers });
  const ready = new Promise<IncomingMessage>((resolve, reject) => {
    req.on("response", (res) => {
      response = res;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end === -1) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (data === undefined) continue;
          const frame: unknown = JSON.parse(data.slice(6));
          const waiter = waiting.shift();
          if (waiter === undefined) frames.push(frame);
          else waiter(frame);
        }
      });
      resolve(res);
    });
    req.on("error", reject);
  });
  req.end();
  return {
    ready,
    next: (): Promise<unknown> =>
      frames.length > 0
        ? Promise.resolve(frames.shift())
        : new Promise((resolve) => waiting.push(resolve)),
    close: () => {
      response?.destroy();
      req.destroy();
    },
  };
}

describe("watch server: network exposure", () => {
  it("answers on 127.0.0.1 and says which host it bound", async () => {
    const { port, server } = await start();
    expect(await server.listen().catch(() => "again")).toBe("again"); // one listen per server
    expect((await get(port, "/health", { Host: `127.0.0.1:${String(port)}` })).body).toBe(
      HEALTH_BODY,
    );
  });

  it("does not accept a connection on any other interface of this machine", async () => {
    const { port } = await start();
    const external = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");
    if (external === undefined) return; // no non-loopback address here: nothing to probe
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: external.address, port });
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        resolve(error.code ?? "error");
      });
    });
    expect(outcome).toBe("ECONNREFUSED");
  });
});

describe("watch server: Host and Origin checks (DNS rebinding)", () => {
  it("serves the loopback and localhost hosts of its own port", async () => {
    const { port } = await start();
    for (const host of [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]) {
      expect((await get(port, "/health", { Host: host })).status).toBe(200);
    }
  });

  it.each([
    ["a foreign name", "evil.example"],
    ["a foreign name on the right port", "evil.example:PORT"],
    ["loopback on another port", "127.0.0.1:1"],
    ["a name that only starts like localhost", "localhost.evil.example:PORT"],
  ])("rejects %s as the Host", async (_label, host) => {
    const { port } = await start();
    const reply = await get(port, "/health", { Host: host.replace("PORT", String(port)) });
    expect(reply).toMatchObject({ status: 403, body: "forbidden host" });
  });

  it("rejects a request with no Host header", async () => {
    const { port } = await start();
    const reply = await new Promise<number>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write("GET /health HTTP/1.0\r\n\r\n");
      });
      socket.on("data", (chunk) => {
        resolve(Number(/^HTTP\/1\.\d (\d+)/.exec(chunk.toString())?.[1]));
        socket.destroy();
      });
    });
    expect(reply).toBe(403);
  });

  it("rejects a foreign Origin even with a good Host", async () => {
    const { port } = await start();
    const reply = await get(port, "/events", {
      Host: `127.0.0.1:${String(port)}`,
      Origin: "http://evil.example",
    });
    expect(reply).toMatchObject({ status: 403, body: "forbidden origin" });
  });

  it("accepts its own origin, and no Origin at all", async () => {
    const { port } = await start();
    const origin = `http://localhost:${String(port)}`;
    const stream = events(port, { Origin: origin });
    try {
      expect((await stream.ready).statusCode).toBe(200);
    } finally {
      stream.close();
    }
    expect((await get(port, "/health")).status).toBe(200);
  });
});

describe("watch server: routes and methods", () => {
  it("is read only: every route takes GET alone", async () => {
    const { port } = await start();
    for (const path of ["/", "/health", "/events"]) {
      const reply = await get(port, path, {}, "POST");
      expect(reply.status).toBe(405);
      expect(reply.headers["allow"]).toBe("GET");
    }
  });

  it("has no route that controls anything: no probe, no unknown path", async () => {
    const { port } = await start();
    expect((await get(port, "/probe", { "X-Omi-Watch": "1" }, "POST")).status).toBe(404);
    expect((await get(port, "/nope")).status).toBe(404);
  });

  it("serves the page under a CSP that allows only its own two inline blocks, by hash", async () => {
    const { port } = await start();
    const page = await get(port, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    const csp = String(page.headers["content-security-policy"]);
    const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    const script = /<script>([\s\S]*?)<\/script>/.exec(page.body)?.[1] ?? "";
    const style = /<style>([\s\S]*?)<\/style>/.exec(page.body)?.[1] ?? "";
    expect(csp).toContain(`script-src ${hash(script)}`);
    expect(csp).toContain(`style-src ${hash(style)}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });
});

describe("watch server: server-sent events", () => {
  it("sends the current snapshot at once, as an ok frame", async () => {
    const { port } = await start();
    const stream = events(port);
    try {
      const response = await stream.ready;
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(await stream.next()).toEqual({ state: "ok", snapshot: snapshot() });
    } finally {
      stream.close();
    }
  });

  it("sends a new frame to every client when the snapshot changes, and none when it does not", async () => {
    let generation = 0;
    const { port } = await start({
      intervalMs: 5,
      readSnapshot: () =>
        Promise.resolve(snapshot(`2026-11-12T10:00:0${String(Math.min(generation, 1))}.000Z`)),
    });
    const [a, b] = [events(port), events(port)];
    try {
      expect(await a.next()).toMatchObject({
        snapshot: { generatedAt: "2026-11-12T10:00:00.000Z" },
      });
      await b.next();
      generation = 1;
      expect(await a.next()).toMatchObject({
        snapshot: { generatedAt: "2026-11-12T10:00:01.000Z" },
      });
      expect(await b.next()).toMatchObject({
        snapshot: { generatedAt: "2026-11-12T10:00:01.000Z" },
      });
    } finally {
      a.close();
      b.close();
    }
  });

  it("reports an unreadable snapshot by a fixed code, never by the error's own text", async () => {
    const { port } = await start({
      readSnapshot: () => Promise.reject(new Error("ENOENT /home/secret/state.sqlite token=abc")),
    });
    const stream = events(port);
    try {
      const frame = await stream.next();
      expect(frame).toEqual({ state: "unavailable", reason: "SNAPSHOT_FAILED" });
      expect(JSON.stringify(frame)).not.toMatch(/secret|token|sqlite/);
    } finally {
      stream.close();
    }
  });

  it("keeps serving after a failed read and recovers when it works again", async () => {
    let failing = true;
    const { port } = await start({
      intervalMs: 5,
      readSnapshot: () =>
        failing ? Promise.reject(new Error("down")) : Promise.resolve(snapshot()),
    });
    const stream = events(port);
    try {
      expect(await stream.next()).toMatchObject({ state: "unavailable" });
      failing = false;
      expect(await stream.next()).toMatchObject({ state: "ok" });
    } finally {
      stream.close();
    }
  });
});

describe("watch server: idle shutdown", () => {
  it("does not read snapshots before the first SSE client connects", async () => {
    let reads = 0;
    const { port } = await start({
      intervalMs: 5,
      readSnapshot: () => {
        reads += 1;
        return Promise.resolve(snapshot());
      },
    });
    await get(port, "/");
    await get(port, "/health");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(0);
    const stream = events(port);
    try {
      await stream.next();
      expect(reads).toBeGreaterThan(0);
    } finally {
      stream.close();
    }
  });
  it("shuts down when no client ever connects", async () => {
    let onIdle = () => {};
    const idle = new Promise<void>((resolve) => {
      onIdle = resolve;
    });
    await start({ idleMs: 30, onIdle });
    await idle;
  });

  it("stays up while a client is connected and shuts down after the last one leaves", async () => {
    let idled = false;
    let onIdle = () => {};
    const idle = new Promise<void>((resolve) => {
      onIdle = resolve;
    });
    const { port } = await start({
      idleMs: 60,
      onIdle: () => {
        idled = true;
        onIdle();
      },
    });
    const stream = events(port);
    try {
      await stream.ready;
      await new Promise((done) => setTimeout(done, 200));
      expect(idled).toBe(false); // a client was connected for 3 idle periods
    } finally {
      stream.close();
    }
    await idle;
    expect(idled).toBe(true);
  });

  it("stops answering once it has closed", async () => {
    const { port, server } = await start();
    await server.close();
    await expect(get(port, "/health")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
