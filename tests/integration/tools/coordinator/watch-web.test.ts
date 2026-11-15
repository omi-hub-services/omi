import { createHash } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchSnapshot } from "../../../../src/application/contracts/watch-snapshot.ts";
import { PAGE_CSP, PAGE_HTML } from "../../../../src/infrastructure/observability/watch-page.ts";
import {
  COORDINATOR_LOGIN,
  QUOTA_SETTINGS,
  WORKER_PROFILES,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import type { Command } from "../../../../tools/coordinator/process-runner.ts";
import {
  createWatchServer,
  isWatchRunning,
  type WatchServer,
} from "../../../../tools/coordinator/watch-web.ts";

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
  readonly onIdle: ReturnType<typeof vi.fn>;
}

/** A server on a random port with a fake runner (WSL "offline"). */
async function start(extra: { idleMs?: number } = {}): Promise<Started> {
  const commands: Command[] = [];
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
    pushIntervalMs: 30,
    ...(extra.idleMs === undefined ? {} : { idleMs: extra.idleMs }),
    clock: () => 1_700_000_000_000,
    onIdle,
  });
  servers.push(server);
  const port = await server.listen();
  return { port, commands, onIdle };
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

interface Frame {
  readonly state: string;
  readonly snapshot?: WatchSnapshot;
}

/** Opens /events and resolves once `frames` data frames arrived; the connection stays open. */
function sse(port: number, frames = 1) {
  return new Promise<{ frames: Frame[]; headers: IncomingHttpHeaders; close(): void }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        let buf = "";
        const seen: Frame[] = [];
        let resolved = false;
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          buf += d;
          for (const part of buf.split("\n\n").slice(0, -1)) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (line) seen.push(JSON.parse(line.slice(6)) as Frame);
          }
          buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
          if (!resolved && seen.length >= frames) {
            resolved = true;
            resolve({
              frames: seen,
              headers: res.headers,
              close: () => {
                req.destroy();
              },
            });
          }
        });
      });
      req.on("error", (e) => {
        if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
      });
      req.end();
    },
  );
}
const lastSnapshot = (frames: readonly Frame[]) => frames.at(-1)?.snapshot;

describe("watch-web serves the framework's one page", () => {
  it("answers / with exactly the framework page and its hashed CSP", async () => {
    const { port } = await start();
    const page = await http(port, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toBe(PAGE_HTML);
    expect(page.headers["content-security-policy"]).toBe(PAGE_CSP);
    expect(page.body).not.toContain("innerHTML");
    for (const tag of ["style", "script"]) {
      const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(page.body)?.[1] ?? "";
      const hash = createHash("sha256").update(block).digest("base64");
      expect(page.headers["content-security-policy"]).toContain(`${tag}-src 'sha256-${hash}'`);
    }
    expect(page.body).not.toMatch(/(?:src|href)=["']https?:/);
    expect(await http(port, "GET", "/health")).toMatchObject({ status: 200, body: "omi-watch" });
    expect(await isWatchRunning(port)).toBe(true);
  });

  it("has no control endpoint: no probe button, no POST /probe, no mutating method", async () => {
    const { port, commands } = await start();
    expect(PAGE_HTML).not.toMatch(/probe|<button|<form/i);
    await vi.waitFor(() => {
      expect(commands.filter(isQuota)).toHaveLength(1);
    });
    const used = commands.length;
    expect((await http(port, "POST", "/probe", { "X-Omi-Watch": "1" })).status).toBe(404);
    expect((await http(port, "GET", "/probe")).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"])
      expect((await http(port, method, "/")).status).toBe(405);
    await new Promise((r) => setTimeout(r, 50));
    expect(commands).toHaveLength(used);
    // the free quota read never probes
    expect(commands.filter(isQuota).every((c) => c.args.at(-1)?.includes("omi-runs 0 "))).toBe(
      true,
    );
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

  it("shares one poller among several open web windows", async () => {
    const { port, commands } = await start();
    const a = await sse(port);
    const count = commands.filter(isQuota).length;
    const b = await sse(port);
    try {
      expect(commands.filter(isQuota)).toHaveLength(count);
      expect(count).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("watch-web streams the shared snapshot", () => {
  it("sends the framework snapshot shape, loading before any read, with every configured profile", async () => {
    const { port } = await start();
    const first = await sse(port);
    expect(first.headers["content-type"]).toContain("text/event-stream");
    const s = lastSnapshot(first.frames);
    expect(first.frames[0]?.state).toBe("ok");
    expect(s?.generatedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(s?.quota.rows.map((r) => r.profile).sort()).toEqual(
      WORKER_PROFILES.map((p) => p.profile).sort(),
    );
    first.close();
  });

  it("marks the board and quota unavailable when the sources are offline, never as zero", async () => {
    const { port } = await start();
    const client = await sse(port);
    try {
      await vi.waitFor(() => {
        const last = lastSnapshot(client.frames);
        expect(last?.board).toBe("unavailable");
        expect(last?.quota.state).toBe("unavailable");
      });
      const rows = lastSnapshot(client.frames)?.quota.rows ?? [];
      expect(rows.every((r) => r.fiveHourLeft === null && r.severity === "unknown")).toBe(true);
    } finally {
      client.close();
    }
  });

  it("keeps serving and recovers when a snapshot cannot be built", async () => {
    let broken = false;
    const server = createWatchServer({
      run: () => Promise.resolve({ code: 127, stdout: "", stderr: "offline" }),
      target,
      profiles: WORKER_PROFILES,
      settings: QUOTA_SETTINGS,
      port: 0,
      pushIntervalMs: 20,
      clock: () => {
        if (broken) throw new Error("snapshot\nfailed");
        return 1_700_000_000_000 + (Date.now() % 1000);
      },
    });
    servers.push(server);
    const port = await server.listen();
    const client = await sse(port);
    try {
      broken = true;
      await vi.waitFor(() => {
        expect(client.frames.some((f) => f.state === "unavailable")).toBe(true);
      });
      expect((await http(port, "GET", "/health")).status).toBe(200);
      broken = false;
      await vi.waitFor(() => {
        expect(client.frames.at(-1)?.state).toBe("ok");
      });
    } finally {
      client.close();
    }
  });

  it("rejects /events from a foreign Host", async () => {
    const { port } = await start();
    expect((await http(port, "GET", "/events", { Host: "evil.example" })).status).toBe(403);
  });
});

describe("watch-web cards from the GitHub, worker and prompt reads", () => {
  const HEAD = "abc1234def5678abc1234def5678abc1234def56";
  const hostile = "[OMI-074] <img src=x onerror=alert(1)>";
  const item = (workflow: string, number = 152, planKey = "OMI-074") => ({
    status: { name: "In Review" },
    priority: { name: "P1" },
    workType: { name: "Task" },
    workflow: { name: workflow },
    role: { name: "Developer" },
    area: null,
    planKey: { text: planKey },
    content: {
      __typename: "Issue",
      number,
      title: hostile,
      state: "OPEN",
      body: "",
      milestone: null,
      blockedBy: { totalCount: 0, nodes: [] },
    },
  });
  const graphql = (workflow = "feature") => ({
    data: {
      organization: {
        projectV2: {
          title: "p",
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [item(workflow)],
          },
        },
      },
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 160,
              title: "t",
              isDraft: false,
              headRefName: "task/omi-074-watch-tasks",
              headRefOid: HEAD,
              baseRefName: "develop",
              body: "Issue: #152",
              reviewDecision: null,
              mergeStateStatus: "CLEAN",
              comments: {
                nodes: [
                  {
                    author: { login: "someone-else" },
                    body: "**VERDICT:** PASS\n**REVIEWED_HEAD:** abc1234",
                  },
                  {
                    author: { login: COORDINATOR_LOGIN },
                    body: "**VERDICT:** FAIL\n**REVIEWED_HEAD:** abc1234",
                  },
                ],
              },
              commits: { nodes: [] },
            },
          ],
        },
      },
    },
  });
  const out = (stdout: string) => Promise.resolve({ code: 0, stdout, stderr: "" });
  const workerList = "@@ps\n 77 1500 1 claude -p x --model opus-5-5 --effort high OMI-074\n@@log\n";

  it("streams a card whose worker is at the step its prompt header names, with a shared layout", async () => {
    const server = createWatchServer({
      run: (c) => {
        const payload = c.args.at(-1) ?? "";
        if (c.file === "gh") return out(JSON.stringify(graphql()));
        if (isQuota(c)) return out("");
        if (payload.includes("-prompt*.md"))
          return out(
            [
              "@@prompt 074",
              "# Workflow feature · step review · role reviewer",
              "## Skill: independent-review (follow it)",
              "## Rule: project-baseline (mandatory)",
              "",
            ].join("\n"),
          );
        return out(workerList);
      },
      target,
      profiles: WORKER_PROFILES,
      settings: QUOTA_SETTINGS,
      port: 0,
      pushIntervalMs: 30,
      clock: () => 1_700_000_000_000,
    });
    servers.push(server);
    const port = await server.listen();
    const client = await sse(port);
    try {
      await vi.waitFor(() => {
        expect(lastSnapshot(client.frames)?.board).toBe("ok");
      });
      const card = lastSnapshot(client.frames)?.tasks[0];
      expect(card).toMatchObject({
        planKey: "OMI-074",
        issueNumber: 152,
        title: hostile,
        workflow: "feature",
        cycle: { failures: 1 },
        loaded: {
          skills: ["independent-review"],
          rules: ["project-baseline"],
          mandatoryRules: ["project-baseline"],
        },
      });
      expect(card?.layout.nodes.map((n) => n.id)).toContain("review");
      // a foreign Host still gets nothing, including the snapshot stream
      expect((await http(port, "GET", "/events", { Host: "evil.example" })).status).toBe(403);
    } finally {
      client.close();
    }
  });

  it("keeps the last good cards and flags the board when GitHub fails later", async () => {
    let githubDown = false;
    const server = createWatchServer({
      run: (c) => {
        const payload = c.args.at(-1) ?? "";
        if (c.file === "gh")
          return githubDown
            ? Promise.resolve({ code: 1, stdout: "", stderr: "HTTP 502" })
            : out(JSON.stringify(graphql()));
        if (isQuota(c)) return out("");
        if (payload.includes("-prompt*.md")) return out("@@missing 074\n");
        return out("@@ps\n@@log\n");
      },
      target,
      profiles: WORKER_PROFILES,
      settings: QUOTA_SETTINGS,
      port: 0,
      pushIntervalMs: 20,
      tasksIntervalMs: 40,
      clock: () => 1_700_000_000_000,
    });
    servers.push(server);
    const port = await server.listen();
    const client = await sse(port);
    try {
      await vi.waitFor(() => {
        expect(lastSnapshot(client.frames)?.tasks).toHaveLength(1);
      });
      githubDown = true;
      await vi.waitFor(() => {
        expect(lastSnapshot(client.frames)?.board).toBe("unavailable");
      });
      expect(lastSnapshot(client.frames)?.tasks).toHaveLength(1);
    } finally {
      client.close();
    }
  });
});

describe("watch-web idle shutdown", () => {
  it("exits from startup when nobody ever connects, calls onIdle and frees the port", async () => {
    const { port, onIdle } = await start({ idleMs: 80 });
    await vi.waitFor(
      () => {
        expect(onIdle).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
    await expect(http(port, "GET", "/health")).rejects.toThrow();
  });

  it("does not exit while a window is connected and exits after the last one closes", async () => {
    const { port, onIdle } = await start({ idleMs: 150 });
    const client = await sse(port);
    await new Promise((r) => setTimeout(r, 300));
    expect(onIdle).not.toHaveBeenCalled();
    client.close();
    await vi.waitFor(
      () => {
        expect(onIdle).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
  });

  it("stops polling after shutdown", async () => {
    const { commands, onIdle } = await start({ idleMs: 80 });
    await vi.waitFor(
      () => {
        expect(onIdle).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((c) => c.signal?.aborted)).toBe(true);
  });
});
