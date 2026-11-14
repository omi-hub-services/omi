import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  launchWindowsSession,
  type SessionSpawn,
} from "../../../src/infrastructure/processes/windows-session-launcher.ts";
let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-launcher-"));
});
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => {
          resolve();
        }),
      );
      child.kill("SIGKILL");
      await closed;
    }),
  );
  rmSync(dir, { recursive: true, force: true });
});
function standIn(
  options: {
    stubborn?: boolean;
    noReady?: boolean;
    runtimeFails?: boolean;
    coordinatorHangs?: boolean;
  } = {},
) {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const launch: SessionSpawn = (executable, args, spawnOptions) => {
    calls.push({ executable, args });
    const runtime = executable === "wsl.exe";
    const script = runtime
      ? `
      const fs = require('node:fs');
      ${options.runtimeFails ? "process.exit(2);" : ""}
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        fs.appendFileSync(${JSON.stringify(join(dir, "pipe.txt"))}, chunk);
        if (chunk.includes('stop') && !${String(options.stubborn ?? false)}) process.exit(0);
      });
      if (!${String(options.noReady ?? false)}) { fs.writeFileSync(${JSON.stringify(join(dir, "ready"))}, 'yes'); console.log('ready'); }
      setInterval(() => {}, 1000);
    `
      : `if (!require('node:fs').existsSync(${JSON.stringify(join(dir, "ready"))})) process.exit(9);
      ${options.coordinatorHangs ? "setInterval(() => {}, 1000)" : "setTimeout(() => process.exit(0), 70)"};`;
    const child = spawn(process.execPath, ["-e", script], {
      ...spawnOptions,
      stdio: runtime ? ["pipe", "pipe", "ignore"] : "ignore",
    });
    children.push(child);
    return child;
  };
  return { launch, calls };
}
const input = {
  projectDir: "/tmp/project with space",
  runtimePath: "/opt/omi/runtime.js",
  distribution: "Ubuntu-24.04",
  coordinator: "coordinator.exe",
};
describe("Windows session launcher with Linux stand-ins", () => {
  it("passes argv without a shell, waits for readiness, holds heartbeats and sends stop after Coordinator exit", async () => {
    const { launch, calls } = standIn();
    const result = await launchWindowsSession(input, {
      spawn: launch,
      heartbeatPeriodMs: 10,
      stopTimeoutMs: 2000,
    });
    expect(result).toEqual({ exitCode: 0, runtimeStopped: true });
    expect(calls).toEqual([
      {
        executable: "wsl.exe",
        args: [
          "--distribution",
          "Ubuntu-24.04",
          "--cd",
          input.projectDir,
          "--exec",
          `${input.projectDir}/.omi-squad/bin/omi`,
          "--omi-node-exec",
          input.runtimePath,
          input.projectDir,
        ],
      },
      { executable: "coordinator.exe", args: [] },
    ]);
    const pipe = readFileSync(join(dir, "pipe.txt"), "utf8");
    expect(pipe.match(/heartbeat/g)?.length).toBeGreaterThan(1);
    expect(pipe).toContain("stop\n");
  });
  it("gracefully stops on launcher shutdown and removes signal listeners", async () => {
    const signals = new EventEmitter();
    const { launch, calls } = standIn({ coordinatorHangs: true });
    const result = launchWindowsSession(input, {
      spawn: launch,
      signalSource: signals,
      heartbeatPeriodMs: 10,
      stopTimeoutMs: 1000,
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    signals.emit("SIGINT");
    expect((await result).runtimeStopped).toBe(true);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(readFileSync(join(dir, "pipe.txt"), "utf8")).toContain("stop");
  });
  it("bounds a hung runtime and reports that worker teardown is unconfirmed", async () => {
    const { launch } = standIn({ stubborn: true });
    const result = await launchWindowsSession(input, {
      spawn: launch,
      heartbeatPeriodMs: 10,
      stopTimeoutMs: 50,
    });
    expect(result.runtimeStopped).toBe(false);
  });
  it.each([{ noReady: true }, { runtimeFails: true }])(
    "never starts a Coordinator when runtime startup fails: %j",
    async (mode) => {
      const { launch, calls } = standIn(mode);
      await expect(
        launchWindowsSession(input, { spawn: launch, startupTimeoutMs: 100, stopTimeoutMs: 100 }),
      ).rejects.toThrow("RUNTIME_START_FAILED");
      expect(calls).toHaveLength(1);
    },
  );
  it("rejects malformed launch input before spawning", async () => {
    const { launch, calls } = standIn();
    await expect(
      launchWindowsSession({ ...input, projectDir: "C:\\repo" }, { spawn: launch }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "ready"))).toBe(false);
  });
});
