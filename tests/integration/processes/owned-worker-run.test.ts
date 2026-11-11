import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  runWorkerUnderOwner,
  type OwnedWorkerRun,
} from "../../../src/infrastructure/processes/owned-worker-run.js";
import type { SupervisedProcessOptions } from "../../../src/infrastructure/processes/supervised-process.js";

// Real worker processes in temp dirs; the "owner" is an in-memory pipe, so nothing here depends on
// a launcher. The cross-process version of these cases is tests/live/wsl-lifecycle/.
let dir: string;
let workDir: string;
// Everything this file spawns, so cleanup only ever signals what the test itself created.
const spawnedGroups = new Set<number>();
const unrelated: ChildProcess[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-owned-worker-"));
  workDir = join(dir, "work");
});
beforeEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});
afterEach(() => {
  for (const pgid of spawnedGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  spawnedGroups.clear();
  for (const child of unrelated.splice(0)) child.kill("SIGKILL");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A zombie is dead for our purposes; it only waits to be reaped.
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${String(pid)}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A worker that leaves an uncommitted file, starts a tool subprocess, then announces itself. */
function workerScript(behaviour: "polite" | "stubborn" | "short"): string {
  const path = join(dir, `worker-${behaviour}.mjs`);
  writeFileSync(
    path,
    `import { spawn } from "node:child_process";
     import { mkdirSync, writeFileSync } from "node:fs";
     mkdirSync(${JSON.stringify(workDir)}, { recursive: true });
     writeFileSync(${JSON.stringify(join(workDir, "uncommitted.txt"))}, "work in progress");
     const tool = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
     const behaviour = ${JSON.stringify(behaviour)};
     if (behaviour === "short") {
       console.log("tool " + tool.pid);
       tool.kill("SIGKILL");
       tool.once("exit", () => process.exit(0));
     } else {
       process.on("SIGINT", () => {
         if (behaviour === "stubborn") return;
         writeFileSync(${JSON.stringify(join(workDir, "checkpoint.txt"))}, "interrupted");
         process.exit(0);
       });
       console.log("tool " + tool.pid); // after the handler exists
       setInterval(() => undefined, 1000);
     }`,
  );
  return path;
}

interface Started {
  run: OwnedWorkerRun;
  channel: PassThrough;
  toolPid: number;
}

async function startOwned(
  behaviour: "polite" | "stubborn" | "short",
  overrides: Partial<SupervisedProcessOptions> = {},
): Promise<Started> {
  const lines: string[] = [];
  const channel = new PassThrough();
  const run = await runWorkerUnderOwner({
    worker: {
      executable: process.execPath,
      args: [workerScript(behaviour)],
      cwd: dir,
      env: {},
      stdin: "",
      onStdoutLine: (line) => lines.push(line),
      timeoutMs: 30_000,
      graceMs: 5000,
      maxStdoutChars: 1_000_000,
      maxLineChars: 100_000,
      maxStderrChars: 1000,
      ...overrides,
    },
    owner: { channel },
  });
  spawnedGroups.add(run.worker.pid);
  await waitFor(() => lines.some((l) => l.startsWith("tool ")), "the worker to be ready");
  const toolPid = Number((lines.find((l) => l.startsWith("tool ")) ?? "").slice(5));
  return { run, channel, toolPid };
}

function startUnrelatedProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  unrelated.push(child);
  return child;
}

describe("runWorkerUnderOwner", () => {
  it("stops the worker group when the owner's pipe closes, and keeps the worker's files", async () => {
    const other = startUnrelatedProcess();
    const { run, channel, toolPid } = await startOwned("polite");
    expect(isRunning(toolPid)).toBe(true);

    channel.destroy(); // abrupt: no goodbye
    const result = await run.result;

    expect(result.ownerGone).toEqual({ reason: "channel-closed" });
    expect(result.workerExit).toMatchObject({
      exitCode: 0,
      cancelRequested: true,
      escalated: false,
    });
    await waitFor(() => !isRunning(toolPid), "the tool subprocess to die");
    expect(readFileSync(join(workDir, "uncommitted.txt"), "utf8")).toBe("work in progress");
    expect(readFileSync(join(workDir, "checkpoint.txt"), "utf8")).toBe("interrupted");
    expect(other.pid).toBeDefined();
    expect(isRunning(other.pid ?? 0)).toBe(true);
  });

  it("stops the group on the graceful goodbye as well", async () => {
    const { run, channel, toolPid } = await startOwned("polite");
    channel.write("stop\n");
    const result = await run.result;
    expect(result.ownerGone).toEqual({ reason: "stop-requested" });
    expect(result.workerExit.cancelRequested).toBe(true);
    await waitFor(() => !isRunning(toolPid), "the tool subprocess to die");
  });

  it("kills the group after the grace period when the worker ignores the interrupt", async () => {
    const { run, channel, toolPid } = await startOwned("stubborn", { graceMs: 300 });
    channel.destroy();
    const result = await run.result;
    expect(result.workerExit).toMatchObject({ signal: "SIGKILL", escalated: true });
    await waitFor(() => !isRunning(toolPid), "the tool subprocess to die");
    expect(existsSync(join(workDir, "uncommitted.txt"))).toBe(true);
  });

  it("resolves ownerGone so a dispatcher can stop handing out work", async () => {
    const { run, channel } = await startOwned("polite");
    channel.destroy();
    await expect(run.ownerGone).resolves.toEqual({ reason: "channel-closed" });
    await run.result;
  });

  it("leaves everything alone when the worker finishes first, and stops watching the owner", async () => {
    const other = startUnrelatedProcess();
    const { run, channel } = await startOwned("short");
    const result = await run.result;
    expect(result.ownerGone).toBeNull();
    expect(result.workerExit.cancelRequested).toBe(false);
    expect(channel.listenerCount("data")).toBe(0);
    expect(isRunning(other.pid ?? 0)).toBe(true);
  });

  it("rejects, without leaving a watcher behind, when the worker cannot be spawned", async () => {
    mkdirSync(workDir, { recursive: true });
    const channel = new PassThrough();
    await expect(
      runWorkerUnderOwner({
        worker: {
          executable: join(dir, "does-not-exist"),
          args: [],
          cwd: dir,
          env: {},
          stdin: "",
          onStdoutLine: () => undefined,
          timeoutMs: 1000,
          graceMs: 100,
          maxStdoutChars: 1000,
          maxLineChars: 1000,
          maxStderrChars: 1000,
        },
        owner: { channel },
      }),
    ).rejects.toThrow();
    expect(channel.listenerCount("data")).toBe(0);
  });
});
