import { createHash } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUOTA_SETTINGS,
  WORKER_PROFILES,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import type { Command } from "../../../../tools/coordinator/process-runner.ts";
import {
  createWatchServer,
  isWatchRunning,
  type Scheduler,
  type WatchServer,
} from "../../../../tools/coordinator/watch-web.ts";
import type { WatchSnapshot } from "../../../../tools/coordinator/watch-snapshot.ts";

const target = { viaWslExe: true, distro: "test", repoDir: "/test" };
const isQuota = (c: Command) => c.input?.includes("account/rateLimits/read") === true;

let servers: WatchServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

interface Started {
  readonly port: number;
  readonly commands: Command[];
  readonly idle: { fn: (() => void) | null; ms: number; sets: number; clears: number };
  readonly onIdle: ReturnType<typeof vi.fn>;
}

/** A server on a random port with a fake runner (WSL "offline") and a manual idle timer. */
async function start(extra: { idleMs?: number; realTimer?: boolean } = {}): Promise<Started> {
  const commands: Command[] = [];
  const idle: Started["idle"] = { fn: null, ms: 0, sets: 0, clears: 0 };
  const scheduler: Scheduler = {
    set: (fn, ms) => {
      idle.fn = fn;
      idle.ms = ms;
      idle.sets++;
      return idle.sets;
    },
    clear: () => {
      idle.fn = null;
      idle.clears++;
    },
  };
  const onIdle = vi.fn();
  const server = createWatchServer({
    run: (c) => {
      commands.push(c);
      return Promise.resolve({ code: 127, stdout: "", stderr: "offline" });
    },
    target,
    profiles: WORKER_PROFILES,
    settings: QUOTA_SETTINGS,
    port: 0,
    workerIntervalMs: 60_000,
    quotaIntervalMs: 60_000,
    ...(extra.idleMs === undefined ? {} : { idleMs: extra.idleMs }),
    ...(extra.realTimer ? {} : { scheduler }),
    clock: () => 1_700_000_000_000,
    onIdle,
  });
  servers.push(server);
  const port = await server.listen();
  return { port, commands, idle, onIdle };
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (body += d));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Opens /events and resolves once `frames` data frames arrived; the connection stays open. */
function sse(port: number, frames = 1) {
  return new Promise<{ snapshots: WatchSnapshot[]; headers: IncomingHttpHeaders; close(): void }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        let buf = "";
        const snapshots: WatchSnapshot[] = [];
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          buf += d;
          for (const part of buf.split("\n\n").slice(0, -1)) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (line) snapshots.push(JSON.parse(line.slice(6)) as WatchSnapshot);
          }
          buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
          if (snapshots.length >= frames)
            resolve({
              snapshots,
              headers: res.headers,
              close: () => {
                req.destroy();
              },
            });
        });
      });
      req.on("error", (e) => {
        if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
      });
      req.end();
    },
  );
}

describe("watch-web HTTP", () => {
  it("logs a broadcast failure on one line, keeps serving and recovers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let broken = false;
    let finishWorker:
      ((value: { code: number; stdout: string; stderr: string }) => void) | undefined;
    const server = createWatchServer({
      run: (command) =>
        isQuota(command)
          ? Promise.resolve({ code: 0, stdout: "", stderr: "" })
          : new Promise((resolve) => {
              finishWorker = resolve;
            }),
      target,
      profiles: WORKER_PROFILES,
      settings: QUOTA_SETTINGS,
      port: 0,
      clock: () => {
        if (broken) throw new Error("snapshot\nfailed");
        return 1_700_000_000_000;
      },
    });
    servers.push(server);
    const port = await server.listen();
    const client = await sse(port);
    try {
      broken = true;
      finishWorker?.({ code: 0, stdout: "@@ps\n@@log\n", stderr: "" });
      await vi.waitFor(() => {
        expect(error).toHaveBeenCalledWith("watch-web: snapshot failed");
      });
      expect((await http(port, "GET", "/health")).status).toBe(200);
      broken = false;
      expect((await http(port, "POST", "/probe", { "X-Omi-Watch": "1" })).status).toBe(202);
      await vi.waitFor(() => {
        expect(client.snapshots.length).toBeGreaterThan(1);
      });
    } finally {
      client.close();
      error.mockRestore();
    }
  });

  it("shares one poller among several open web windows", async () => {
    const { port, commands } = await start();
    const a = await sse(port);
    const count = commands.filter(isQuota).length;
    const b = await sse(port);
    try {
      expect(await isWatchRunning(port)).toBe(true);
      expect(commands.filter(isQuota)).toHaveLength(count);
      expect(count).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });

  it("serves the page, health and 404/405 on 127.0.0.1", async () => {
    const { port } = await start();
    const page = await http(port, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.body).toContain("EventSource");
    expect(page.body).not.toContain("innerHTML");
    // the CSP allows exactly the two inline blocks, by hash
    for (const tag of ["style", "script"]) {
      const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(page.body)?.[1] ?? "";
      const hash = createHash("sha256").update(block).digest("base64");
      expect(page.headers["content-security-policy"]).toContain(`${tag}-src 'sha256-${hash}'`);
    }
    expect(page.body).not.toMatch(/(?:src|href)=["']https?:/);
    expect(await http(port, "GET", "/health")).toMatchObject({ status: 200, body: "omi-watch" });
    expect((await http(port, "GET", "/nope")).status).toBe(404);
    expect((await http(port, "POST", "/")).status).toBe(405);
    expect((await http(port, "GET", "/probe")).status).toBe(405);
    expect(await isWatchRunning(port)).toBe(true);
  });

  it("accepts localhost:<port> and rejects a foreign Host or Origin on every route", async () => {
    const { port } = await start();
    expect((await http(port, "GET", "/health", { Host: `localhost:${String(port)}` })).status).toBe(
      200,
    );
    for (const host of ["evil.example", `evil.example:${String(port)}`, "127.0.0.1", "127.0.0.1:1"])
      for (const path of ["/", "/health", "/events"])
        expect((await http(port, "GET", path, { Host: host })).status, `${host}${path}`).toBe(403);
    const good = `http://127.0.0.1:${String(port)}`;
    expect((await http(port, "GET", "/health", { Origin: good })).status).toBe(200);
    for (const origin of ["http://evil.example", "null", `https://127.0.0.1:${String(port)}`])
      expect((await http(port, "GET", "/health", { Origin: origin })).status, origin).toBe(403);
  });

  it("refuses POST /probe without X-Omi-Watch: 1 and never reads quota for it", async () => {
    const { port, commands } = await start();
    await vi.waitFor(() => {
      expect(commands.filter(isQuota)).toHaveLength(1);
    });
    const free = commands.length;
    expect((await http(port, "POST", "/probe")).status).toBe(403);
    expect((await http(port, "POST", "/probe", { "X-Omi-Watch": "0" })).status).toBe(403);
    expect(
      (await http(port, "POST", "/probe", { "X-Omi-Watch": "1", Origin: "http://evil.example" }))
        .status,
    ).toBe(403);
    expect(
      (await http(port, "POST", "/probe", { "X-Omi-Watch": "1", Host: "evil.example" })).status,
    ).toBe(403);
    await new Promise((r) => setTimeout(r, 50));
    expect(commands).toHaveLength(free);
    // the free quota read never probes
    expect(commands.filter(isQuota).every((c) => c.args.at(-1)?.includes("omi-runs 0 "))).toBe(
      true,
    );
  });

  it("runs a probe for POST /probe with the header", async () => {
    const { port, commands } = await start();
    await vi.waitFor(() => {
      expect(commands.filter(isQuota)).toHaveLength(1);
    });
    const res = await http(port, "POST", "/probe", { "X-Omi-Watch": "1" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => {
      expect(commands.filter(isQuota).at(-1)?.args.at(-1)).toContain("omi-runs 1 ");
    });
  });
});

describe("watch-web SSE", () => {
  it("sends a snapshot on connect and another when data changes", async () => {
    const { port } = await start();
    const first = await sse(port);
    expect(first.headers["content-type"]).toContain("text/event-stream");
    const s = first.snapshots[0];
    expect(s?.generatedAt).toBe(1_700_000_000);
    expect(s?.quota.profiles.map((p) => p.profile)).toEqual(WORKER_PROFILES.map((p) => p.profile));
    // starting a probe changes the data, which is pushed to the open stream (the fake runner
    // answers "offline")
    const seen = first.snapshots.length;
    await http(port, "POST", "/probe", { "X-Omi-Watch": "1" });
    await vi.waitFor(() => {
      expect(first.snapshots.length).toBeGreaterThan(seen);
    });
    await vi.waitFor(() => {
      const last = first.snapshots.at(-1);
      expect(last?.workers).toMatchObject({ state: "unavailable" });
      expect(last?.quota.state).toBe("unavailable");
      expect(last?.probing).toBe(false);
    });
    expect(first.snapshots.some((x) => x.probing)).toBe(true);
    first.close();
  });

  it("rejects /events from a foreign Host", async () => {
    const { port } = await start();
    expect((await http(port, "GET", "/events", { Host: "evil.example" })).status).toBe(403);
  });
});

describe("watch-web idle shutdown", () => {
  it("starts a 60 s timer at launch, cancels it while a client is connected, re-arms on disconnect", async () => {
    const { port, idle } = await start();
    expect(idle.ms).toBe(60_000);
    expect(idle.fn).not.toBeNull();
    const client = await sse(port);
    expect(idle.fn).toBeNull();
    const second = await sse(port);
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(idle.fn).toBeNull(); // one client left
    second.close();
    await vi.waitFor(() => {
      expect(idle.fn).not.toBeNull();
    });
    expect(idle.ms).toBe(60_000);
  });

  it("closes the server and calls onIdle when the timer fires with no client", async () => {
    const { port, idle, onIdle } = await start();
    const client = await sse(port);
    client.close();
    await vi.waitFor(() => {
      expect(idle.fn).not.toBeNull();
    });
    idle.fn?.();
    await vi.waitFor(() => {
      expect(onIdle).toHaveBeenCalledTimes(1);
    });
    await expect(http(port, "GET", "/health")).rejects.toThrow();
  });

  it("also exits from startup when nobody ever connects (real timer, short)", async () => {
    const { port, onIdle } = await start({ idleMs: 80, realTimer: true });
    await vi.waitFor(
      () => {
        expect(onIdle).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
    await expect(http(port, "GET", "/health")).rejects.toThrow();
  });

  it("stops polling after shutdown", async () => {
    const { idle, commands } = await start();
    await vi.waitFor(() => {
      expect(commands.length).toBeGreaterThan(0);
    });
    idle.fn?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(commands.every((c) => c.signal?.aborted)).toBe(true);
  });
});
