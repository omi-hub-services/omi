import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeIpcServer, defaultSocketPath } from "../../../src/bootstrap/container.js";
import { encodeFrame } from "../../../src/interfaces/ipc/frame-codec.js";
import type { IpcServer } from "../../../src/interfaces/ipc/ipc-server.js";

const repo = resolve(import.meta.dirname, "../../..");
const identity = { runtimeVersion: "9.9.9", startedAt: "2026-11-10T12:00:00.000Z" };

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the real executable entrypoint as a child process, so exit codes are the process's own. */
function omi(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [
        "--import",
        join(repo, "tools/register-ts-imports.ts"),
        join(repo, "src/bootstrap/cli.ts"),
        ...args,
      ],
      { cwd, env: { PATH: process.env["PATH"] ?? "", ...env }, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        done({ code, stdout, stderr });
      },
    );
  });
}

let dir: string;
let server: IpcServer | undefined;
let peer: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omi-cli-"));
});

afterEach(async () => {
  await server?.stop();
  await new Promise<void>((resolveClose) => {
    if (peer === undefined) resolveClose();
    else {
      peer.close(() => {
        resolveClose();
      });
    }
  });
  server = undefined;
  peer = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function startRuntime(path: string): Promise<void> {
  server = createRuntimeIpcServer({ socketPath: path, identity });
  await server.start();
}

async function startPeer(path: string, onConnection: (socket: Socket) => void): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  peer = createServer(onConnection);
  await new Promise<void>((resolveListen) => peer?.listen(path, resolveListen));
}

describe("exit code 0: OK", () => {
  it("prints text status from the default socket under the working directory", async () => {
    await startRuntime(defaultSocketPath(dir));
    const run = await omi(dir, ["status"]);
    expect(run).toEqual({
      code: 0,
      stdout: "runtime: ready\nversion: 9.9.9\nstarted: 2026-11-10T12:00:00.000Z\n",
      stderr: "",
    });
  });

  it("prints one JSON document with --json and honours OMI_SQUAD_SOCKET and --socket", async () => {
    const path = join(dir, "custom", "runtime.sock");
    await startRuntime(path);
    const viaEnv = await omi(dir, ["--json", "status"], { OMI_SQUAD_SOCKET: path });
    expect(viaEnv.code).toBe(0);
    expect(JSON.parse(viaEnv.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      exitCode: 0,
      result: { state: "ready", runtimeVersion: "9.9.9" },
    });
    const viaFlag = await omi(dir, ["status", "--json", "--socket", path]);
    expect(viaFlag.code).toBe(0);
  });

  it("exits 0 for --help and --version", async () => {
    const help = await omi(dir, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("status");
    expect((await omi(dir, ["--version"])).code).toBe(0);
  });
});

describe("exit code 2: USAGE", () => {
  it("rejects an unknown command, an unknown option and a missing command", async () => {
    for (const args of [["frobnicate"], ["status", "--nope"], []]) {
      const run = await omi(dir, args);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("error[USAGE]");
    }
  });

  it("reports usage errors as JSON on stdout with --json", async () => {
    const run = await omi(dir, ["--json", "frobnicate"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      error: { code: "USAGE" },
    });
  });
});

describe("exit code 3: RUNTIME_UNAVAILABLE", () => {
  it("when no runtime listens on the socket", async () => {
    const run = await omi(dir, ["status"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("error[RUNTIME_UNAVAILABLE]");
    const json = await omi(dir, ["status", "--json"]);
    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      exitCode: 3,
      error: { code: "RUNTIME_UNAVAILABLE" },
    });
  });
});

describe("exit code 4: REQUEST_REJECTED", () => {
  it("when the runtime answers with a typed rejection", async () => {
    const path = join(dir, "reject", "runtime.sock");
    await startPeer(path, (socket) => {
      socket.on("data", (data: Buffer) => {
        const request = JSON.parse(data.subarray(4).toString("utf8")) as { requestId: string };
        socket.write(
          encodeFrame(
            JSON.stringify({
              protocolVersion: 1,
              requestId: request.requestId,
              ok: false,
              error: {
                code: "UNSUPPORTED_VERSION",
                message: "protocol version 1 is not supported",
              },
            }),
          ),
        );
      });
    });
    const run = await omi(dir, ["status", "--socket", path]);
    expect(run.code).toBe(4);
    expect(run.stderr).toContain("error[UNSUPPORTED_VERSION]");
  });
});

describe("exit code 5: PROTOCOL_ERROR", () => {
  it("when the runtime answers with garbage", async () => {
    const path = join(dir, "garbage", "runtime.sock");
    await startPeer(path, (socket) => {
      socket.on("data", () => socket.write(encodeFrame("this is not json")));
    });
    const run = await omi(dir, ["status", "--socket", path]);
    expect(run.code).toBe(5);
    expect(run.stderr).toContain("error[PROTOCOL_ERROR]");
  });

  it("when the status payload has the wrong shape", async () => {
    const path = join(dir, "shape", "runtime.sock");
    await startPeer(path, (socket) => {
      socket.on("data", (data: Buffer) => {
        const request = JSON.parse(data.subarray(4).toString("utf8")) as { requestId: string };
        socket.write(
          encodeFrame(
            JSON.stringify({
              protocolVersion: 1,
              requestId: request.requestId,
              ok: true,
              result: { hello: 1 },
            }),
          ),
        );
      });
    });
    const run = await omi(dir, ["status", "--socket", path]);
    expect(run.code).toBe(5);
  });
});
