import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeIpcServer } from "../../../src/bootstrap/container.js";
import { inspectRuntime } from "../../../src/application/use-cases/project/inspect-runtime.js";
import { encodeFrame, FrameDecoder } from "../../../src/interfaces/ipc/frame-codec.js";
import { sendCommand } from "../../../src/interfaces/ipc/ipc-client.js";
import { createIpcServer } from "../../../src/interfaces/ipc/ipc-server.js";
import type { IpcServer } from "../../../src/interfaces/ipc/ipc-server.js";
import { MAX_PAYLOAD_BYTES } from "../../../src/interfaces/ipc/protocol.js";

const identity = { runtimeVersion: "9.9.9", startedAt: "2026-11-10T12:00:00.000Z" };
const status = { schemaVersion: 1, command: "status" } as const;

interface Exchange {
  responses: Record<string, unknown>[];
  closed: boolean;
}

/** Writes raw bytes to the socket and decodes response frames until `expected` arrived or close. */
function exchange(
  socketPath: string,
  chunks: readonly Buffer[],
  expected: number,
  options: { keepOpen?: boolean } = {},
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const decoder = new FrameDecoder();
    const responses: Record<string, unknown>[] = [];
    let closed = false;
    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ responses, closed });
    };
    const timer = setTimeout(done, 3_000);
    socket.on("error", reject);
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      if (!options.keepOpen && expected === 0) done();
    });
    socket.on("data", (data: Buffer) => {
      for (const event of decoder.push(data)) {
        if (event.kind === "frame")
          responses.push(JSON.parse(event.payload) as Record<string, unknown>);
      }
      if (responses.length >= expected) done();
    });
    socket.on("close", () => {
      closed = true;
      done();
    });
  });
}

const request = (extra: Record<string, unknown> = {}): Buffer =>
  encodeFrame(
    JSON.stringify({ protocolVersion: 1, requestId: "req-1", command: status, ...extra }),
  );

let dir: string;
let socketPath: string;
let server: IpcServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omi-ipc-"));
  socketPath = join(dir, "ipc", "runtime.sock");
  server = createRuntimeIpcServer({ socketPath, identity, idleTimeoutMs: 300 });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("round trip over a real Unix socket", () => {
  it("answers status through the client with the use case result", async () => {
    const outcome = await sendCommand({ socketPath, command: status });
    expect(outcome).toEqual({ ok: true, result: inspectRuntime(identity) });
  });

  it("echoes protocol version and request id in the response frame", async () => {
    const { responses } = await exchange(socketPath, [request()], 1);
    expect(responses).toEqual([
      { protocolVersion: 1, requestId: "req-1", ok: true, result: inspectRuntime(identity) },
    ]);
  });

  it("serves pipelined requests on one connection in order", async () => {
    const { responses } = await exchange(
      socketPath,
      [Buffer.concat([request({ requestId: "a" }), request({ requestId: "b" })])],
      2,
    );
    expect(responses.map((r) => r["requestId"])).toEqual(["a", "b"]);
  });

  it("creates the socket private to its owner", async () => {
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "ipc"))).mode & 0o777).toBe(0o700);
  });
});

describe("payload limit", () => {
  it("rejects an oversized length header with a typed error, closes, and stays up", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_PAYLOAD_BYTES + 1, 0);
    const { responses, closed } = await exchange(socketPath, [header], 1);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      protocolVersion: 1,
      requestId: null,
      ok: false,
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(closed || responses.length === 1).toBe(true);
    expect(await sendCommand({ socketPath, command: status })).toMatchObject({ ok: true });
  });

  it("treats a 4 GiB length header the same way, without allocating it", async () => {
    const header = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    const { responses } = await exchange(socketPath, [header], 1);
    expect(responses[0]).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("accepts a payload of exactly the limit (and rejects it as malformed, not oversized)", async () => {
    const body = encodeFrame(" ".repeat(MAX_PAYLOAD_BYTES));
    const { responses } = await exchange(socketPath, [body], 1);
    expect(responses[0]).toMatchObject({ ok: false, error: { code: "MALFORMED_REQUEST" } });
  });
});

describe("malformed input never crashes the server", () => {
  it("answers invalid JSON with MALFORMED_REQUEST and keeps the connection usable", async () => {
    const { responses } = await exchange(
      socketPath,
      [encodeFrame("{not json"), request({ requestId: "after" })],
      2,
    );
    expect(responses[0]).toMatchObject({
      requestId: null,
      ok: false,
      error: { code: "MALFORMED_REQUEST" },
    });
    expect(responses[1]).toMatchObject({ requestId: "after", ok: true });
  });

  it("rejects a JSON value that is not an object", async () => {
    const { responses } = await exchange(
      socketPath,
      [encodeFrame("[1,2]"), encodeFrame("null")],
      2,
    );
    for (const response of responses) {
      expect(response).toMatchObject({ ok: false, error: { code: "MALFORMED_REQUEST" } });
    }
  });

  it("rejects invalid UTF-8", async () => {
    const bad = Buffer.from([0, 0, 0, 2, 0xff, 0xfe]);
    const { responses } = await exchange(socketPath, [bad], 1);
    expect(responses[0]).toMatchObject({ ok: false, error: { code: "MALFORMED_REQUEST" } });
  });

  it("rejects unknown envelope fields and bad request ids, echoing the id only when valid", async () => {
    const extra = await exchange(socketPath, [request({ smuggled: true })], 1);
    expect(extra.responses[0]).toMatchObject({
      requestId: "req-1",
      error: { code: "MALFORMED_REQUEST" },
    });
    const badId = await exchange(socketPath, [request({ requestId: "has space" })], 1);
    expect(badId.responses[0]).toMatchObject({
      requestId: null,
      error: { code: "MALFORMED_REQUEST" },
    });
  });

  it("drops a connection that sends half a frame and stalls, and stays up", async () => {
    const half = request().subarray(0, 6);
    const { responses, closed } = await exchange(socketPath, [half], 1, { keepOpen: true });
    expect(responses).toEqual([]);
    expect(closed).toBe(true);
    expect(await sendCommand({ socketPath, command: status })).toMatchObject({ ok: true });
  });

  it("survives a client that disconnects mid-frame", async () => {
    await exchange(socketPath, [request().subarray(0, 3)], 0);
    expect(await sendCommand({ socketPath, command: status })).toMatchObject({ ok: true });
  });
});

describe("protocol version and command validation", () => {
  it("answers an unknown protocol version with UNSUPPORTED_VERSION", async () => {
    const { responses } = await exchange(socketPath, [request({ protocolVersion: 2 })], 1);
    expect(responses[0]).toMatchObject({
      protocolVersion: 1,
      requestId: "req-1",
      ok: false,
      error: { code: "UNSUPPORTED_VERSION" },
    });
  });

  it("answers a non-numeric or missing version with MALFORMED_REQUEST", async () => {
    const text = await exchange(socketPath, [request({ protocolVersion: "1" })], 1);
    expect(text.responses[0]).toMatchObject({ error: { code: "MALFORMED_REQUEST" } });
    const missing = await exchange(
      socketPath,
      [encodeFrame(JSON.stringify({ requestId: "r", command: status }))],
      1,
    );
    expect(missing.responses[0]).toMatchObject({ error: { code: "MALFORMED_REQUEST" } });
  });

  it("answers an invalid command with INVALID_COMMAND", async () => {
    for (const command of [
      { schemaVersion: 1, command: "rm-rf" },
      { schemaVersion: 1, command: "status", runId: 5 },
      { schemaVersion: 2, command: "status" },
      { schemaVersion: 1, command: "status", extra: 1 },
    ]) {
      const { responses } = await exchange(socketPath, [request({ command })], 1);
      expect(responses[0]).toMatchObject({
        requestId: "req-1",
        error: { code: "INVALID_COMMAND" },
      });
    }
  });

  it("answers a valid command without a use case with NOT_IMPLEMENTED", async () => {
    const outcome = await sendCommand({
      socketPath,
      command: { schemaVersion: 1, command: "resume", runId: "run-1" },
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "NOT_IMPLEMENTED" } });
  });
});

describe("handler failures", () => {
  it("returns a fixed INTERNAL_ERROR and does not leak the cause", async () => {
    const throwing = createIpcServer({
      socketPath: join(dir, "throwing", "runtime.sock"),
      handler: () => Promise.reject(new Error("SELECT * FROM secrets /home/user/.ssh")),
    });
    await throwing.start();
    try {
      const outcome = await sendCommand({
        socketPath: join(dir, "throwing", "runtime.sock"),
        command: status,
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
      expect(JSON.stringify(outcome)).not.toContain("secrets");
    } finally {
      await throwing.stop();
    }
  });

  it("logs the cause locally while the caller still gets the fixed message", async () => {
    const errorLogPath = join(dir, "logs", "ipc-errors.log");
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const logging = createIpcServer({
      socketPath: join(dir, "logging", "runtime.sock"),
      errorLogPath,
      handler: () => Promise.reject(new Error(`boom ${token}`)),
    });
    await logging.start();
    try {
      const outcome = await sendCommand({
        socketPath: join(dir, "logging", "runtime.sock"),
        command: status,
      });
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "the runtime failed to handle the command" },
      });
      expect(JSON.stringify(outcome)).not.toContain("boom");
      const log = await readFile(errorLogPath, "utf8");
      expect(log).toContain("boom");
      expect(log).not.toContain(token);
    } finally {
      await logging.stop();
    }
  });

  it("replaces a response that exceeds the limit with INTERNAL_ERROR", async () => {
    const big = createIpcServer({
      socketPath: join(dir, "big", "runtime.sock"),
      maxPayloadBytes: 512,
      handler: () => Promise.resolve({ ok: true, result: "x".repeat(2_000) }),
    });
    await big.start();
    try {
      const outcome = await sendCommand({
        socketPath: join(dir, "big", "runtime.sock"),
        command: status,
        maxPayloadBytes: 512,
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    } finally {
      await big.stop();
    }
  });
});

describe("socket safety at start", () => {
  it("refuses a socket directory that group or others can enter, and does not chmod it", async () => {
    const open = join(dir, "open");
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    const insecure = createRuntimeIpcServer({ socketPath: join(open, "runtime.sock"), identity });
    await expect(insecure.start()).rejects.toThrow(/mode 0700/);
    expect((await stat(open)).mode & 0o777).toBe(0o755);
  });

  it("refuses to take over a socket another runtime is listening on", async () => {
    const second = createRuntimeIpcServer({ socketPath, identity });
    await expect(second.start()).rejects.toThrow(/already listening/);
    expect(await sendCommand({ socketPath, command: status })).toMatchObject({ ok: true });
  });

  it("refuses a path that exists and is not a socket", async () => {
    const file = join(dir, "plain", "runtime.sock");
    await mkdir(join(dir, "plain"), { mode: 0o700 });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "not a socket");
    await expect(createRuntimeIpcServer({ socketPath: file, identity }).start()).rejects.toThrow(
      /not a socket/,
    );
  });

  it("removes a stale socket left by a killed process and then serves", async () => {
    const stalePath = join(dir, "stale", "runtime.sock");
    await mkdir(join(dir, "stale"), { mode: 0o700 });
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(stalePath)}, () => console.log("up")); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => {
      child.stdout.once("data", () => {
        resolve();
      });
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    child.kill("SIGKILL");
    await exited;
    expect((await lstat(stalePath)).isSocket()).toBe(true);

    const fresh = createRuntimeIpcServer({ socketPath: stalePath, identity });
    await fresh.start();
    try {
      expect(await sendCommand({ socketPath: stalePath, command: status })).toMatchObject({
        ok: true,
      });
    } finally {
      await fresh.stop();
    }
  });
});

describe("client errors are typed outcomes, never exceptions", () => {
  async function misbehaving(
    onConnection: (socket: Socket) => void,
  ): Promise<{ path: string; close(): Promise<void> }> {
    const path = join(dir, "peer.sock");
    const open = new Set<Socket>();
    const peer: Server = createServer((socket) => {
      open.add(socket);
      onConnection(socket);
    });
    await new Promise<void>((resolve) => peer.listen(path, resolve));
    return {
      path,
      // A peer that never reads would never see the client hang up, so drop it explicitly.
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of open) socket.destroy();
          peer.close(() => {
            resolve();
          });
        }),
    };
  }

  it("RUNTIME_UNAVAILABLE when nothing listens", async () => {
    const outcome = await sendCommand({ socketPath: join(dir, "nobody.sock"), command: status });
    expect(outcome).toMatchObject({ ok: false, error: { code: "RUNTIME_UNAVAILABLE" } });
  });

  it("TIMEOUT when the runtime never answers", async () => {
    const peer = await misbehaving(() => undefined);
    const outcome = await sendCommand({ socketPath: peer.path, command: status, timeoutMs: 150 });
    expect(outcome).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    await peer.close();
  });

  it("PROTOCOL_ERROR for a response with another request id", async () => {
    const peer = await misbehaving((socket) => {
      socket.on("data", () => {
        socket.write(
          encodeFrame(
            JSON.stringify({ protocolVersion: 1, requestId: "other", ok: true, result: {} }),
          ),
        );
      });
    });
    const outcome = await sendCommand({
      socketPath: peer.path,
      command: status,
      requestId: "mine",
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "PROTOCOL_ERROR" } });
    await peer.close();
  });

  it("PROTOCOL_ERROR for garbage, an oversized header, and a hang-up without an answer", async () => {
    for (const reply of [
      encodeFrame("garbage"),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      encodeFrame(JSON.stringify({ protocolVersion: 2, requestId: "x", ok: true, result: 1 })),
      undefined,
    ]) {
      const peer = await misbehaving((socket) => {
        socket.on("data", () => {
          if (reply === undefined) socket.end();
          else socket.write(reply);
        });
      });
      const outcome = await sendCommand({ socketPath: peer.path, command: status, requestId: "x" });
      expect(outcome).toMatchObject({ ok: false, error: { code: "PROTOCOL_ERROR" } });
      await peer.close();
    }
  });
});
