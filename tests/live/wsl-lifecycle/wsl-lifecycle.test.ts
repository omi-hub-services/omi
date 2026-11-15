import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isRunning, OwnedProcesses, processState, waitFor } from "./process-probes.js";

// OMI-005 / ADR-0028: the runtime detects that its owner (the Coordinator side) is gone and stops
// exactly the worker process group it owns. WSL2-only; local processes only, no CLI, no quota.
//
// Topology (all Linux processes, all created by this test):
//   test ── launcher.ts (stand-in for the Windows launcher + wsl.exe, holds the pipe)
//             └─ runtime-entry.ts (stand-in for the WSL2 runtime, watches its stdin)
//                  └─ worker.ts (own process group) ── tool subprocess (same group)
//   test ── an unrelated process in its own group, which must survive every scenario.
//
// The Windows side (a real wsl.exe holding the pipe) is not exercised here; see ADR-0028.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const evidencePath = join(repoRoot, ".tmp", "live", "omi-005-wsl-lifecycle-evidence.json");

const Ready = z.strictObject({
  runtimePid: z.number().int().positive(),
  workerPid: z.number().int().positive(),
  toolPid: z.number().int().positive(),
});
const Report = z.strictObject({
  ownerGone: z.strictObject({
    reason: z.enum(["channel-closed", "stop-requested", "heartbeat-lost", "signal"]),
    signal: z.string().optional(),
  }),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  cancelRequested: z.boolean(),
  escalated: z.boolean(),
  leftoverProcessesKilled: z.boolean(),
});

const owned = new OwnedProcesses();
const evidence: Record<string, unknown>[] = [];
let sandbox: string;

beforeAll(() => {
  const version = readFileSync("/proc/version", "utf8");
  if (process.platform !== "linux" || !/microsoft/i.test(version)) {
    // Fails loudly instead of skipping silently (like the other live suites).
    throw new Error(`the OMI-005 live test is WSL2-only; this kernel is: ${version.trim()}`);
  }
  sandbox = mkdtempSync(join(tmpdir(), "omi-005-"));
});
afterAll(() => {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    JSON.stringify({ node: process.version, kernel: release(), scenarios: evidence }, undefined, 2),
  );
  rmSync(sandbox, { recursive: true, force: true });
});

interface Stack {
  name: string;
  launcher: ChildProcess;
  launcherExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  launcherStderr: () => string;
  ready: z.infer<typeof Ready>;
  repo: string;
  stateDir: string;
  unrelated: ChildProcess;
}
const stacks: Stack[] = [];

afterEach(() => {
  // Only ids registered in `owned`; unfreeze a stopped launcher first so SIGKILL is delivered.
  for (const stack of stacks.splice(0)) {
    const { launcher, ready, unrelated } = stack;
    for (const pid of [launcher.pid, ready.runtimePid, ready.workerPid, ready.toolPid]) {
      if (pid !== undefined) owned.signal(pid, "SIGCONT");
    }
    owned.signal(-ready.workerPid, "SIGKILL");
    owned.signal(ready.toolPid, "SIGKILL");
    owned.signal(ready.runtimePid, "SIGKILL");
    if (launcher.pid !== undefined) owned.signal(-launcher.pid, "SIGKILL");
    if (unrelated.pid !== undefined) owned.signal(unrelated.pid, "SIGKILL");
  }
  owned.clear();
});

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=omi-test", "-c", "user.email=omi-test@example.invalid", ...args],
    { encoding: "utf8" },
  );
}

/** A repository with a modified tracked file, a staged new file, and the worker adds an untracked one. */
function makeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "v1\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-q", "-m", "initial");
  writeFileSync(join(repo, "tracked.txt"), "v2 uncommitted edit\n");
  writeFileSync(join(repo, "staged.txt"), "staged but not committed\n");
  git(repo, "add", "staged.txt");
  return repo;
}

async function startStack(
  name: string,
  options: { behaviour: "polite" | "stubborn"; heartbeatTimeoutMs: number; graceMs: number },
): Promise<Stack> {
  const root = mkdtempSync(join(sandbox, `${name}-`));
  const repo = makeRepo(root);
  const stateDir = join(root, "state");
  mkdirSync(stateDir);

  // Unrelated process: not a child of anything in the stack, its own group.
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  if (unrelated.pid === undefined) throw new Error("unrelated process did not start");
  owned.add(unrelated.pid);

  const config = {
    workDir: repo,
    stateDir,
    workerScript: join(here, "worker.ts"),
    behaviour: options.behaviour,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    graceMs: options.graceMs,
  };
  const launcher = spawn(
    process.execPath,
    [
      join(here, "launcher.ts"),
      "100",
      process.execPath,
      "--import",
      join(repoRoot, "tools", "register-ts-imports.ts"),
      join(here, "runtime-entry.ts"),
      JSON.stringify(config),
    ],
    // Own group: the launcher and runtime are signalled as one group only at cleanup.
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (launcher.pid === undefined) throw new Error("launcher did not start");
  owned.add(launcher.pid);

  const lines: string[] = [];
  let stderr = "";
  launcher.stdout.setEncoding("utf8");
  launcher.stdout.on("data", (chunk: string) => {
    lines.push(...chunk.split("\n").filter(Boolean));
  });
  launcher.stderr.setEncoding("utf8");
  launcher.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const launcherExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      launcher.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );

  let ready: z.infer<typeof Ready>;
  try {
    // The readiness signal: the runtime prints it after its handlers are installed and the
    // worker's interrupt handler exists. No sleeps.
    await waitFor(
      () => lines.some((l) => l.startsWith("ready ")),
      "the runtime to be ready",
      30_000,
    );
    ready = Ready.parse(JSON.parse((lines.find((l) => l.startsWith("ready ")) ?? "").slice(6)));
  } catch (error) {
    // Nothing else knows about this stack yet: stop what this call created.
    owned.signal(-launcher.pid, "SIGKILL");
    owned.signal(unrelated.pid, "SIGKILL");
    throw new Error(`stack ${name} did not start; launcher stderr: ${stderr}`, { cause: error });
  }
  owned.add(ready.runtimePid);
  owned.add(ready.workerPid);
  owned.add(ready.toolPid);
  const stack: Stack = {
    name,
    launcher,
    launcherExit,
    launcherStderr: () => stderr,
    ready,
    repo,
    stateDir,
    unrelated,
  };
  stacks.push(stack);
  expect(isRunning(ready.workerPid)).toBe(true);
  expect(isRunning(ready.toolPid)).toBe(true);
  return stack;
}

interface Outcome {
  report: z.infer<typeof Report>;
  detectMs: number;
}

/** After the trigger: waits for the group to be gone and the runtime to report, then checks AC-3/4. */
async function expectWorkerGroupStopped(stack: Stack, triggeredAt: number): Promise<Outcome> {
  const { ready } = stack;
  await waitFor(
    () => !isRunning(ready.workerPid) && !isRunning(ready.toolPid),
    "the worker group to stop",
  );
  const detectMs = performance.now() - triggeredAt;
  const reportPath = join(stack.stateDir, "runtime-report.json");
  await waitFor(() => existsSync(reportPath), "the runtime report");
  const report = Report.parse(JSON.parse(readFileSync(reportPath, "utf8")));
  await waitFor(() => !isRunning(ready.runtimePid), "the runtime to exit");

  // AC-3: uncommitted files are kept, byte for byte, and git still sees them as uncommitted.
  expect(readFileSync(join(stack.repo, "tracked.txt"), "utf8")).toBe("v2 uncommitted edit\n");
  expect(readFileSync(join(stack.repo, "staged.txt"), "utf8")).toBe("staged but not committed\n");
  expect(readFileSync(join(stack.repo, "worker-output.txt"), "utf8")).toBe(
    "uncommitted worker output\n",
  );
  expect(git(stack.repo, "status", "--porcelain").trim().split("\n").sort()).toEqual([
    " M tracked.txt",
    "?? worker-output.txt",
    "A  staged.txt",
  ]);

  // AC-4: a process the framework did not start is untouched.
  expect(stack.unrelated.pid).toBeDefined();
  expect(isRunning(stack.unrelated.pid ?? 0)).toBe(true);
  expect(stack.unrelated.exitCode).toBeNull();
  expect(stack.unrelated.signalCode).toBeNull();
  return { report, detectMs };
}

function record(name: string, outcome: Outcome, extra: Record<string, unknown> = {}): void {
  evidence.push({
    scenario: name,
    detectMs: Math.round(outcome.detectMs),
    ...outcome.report,
    ...extra,
  });
}

describe("WSL2 lifecycle: the runtime stops its worker group when the owner is gone", () => {
  it("graceful owner exit (SIGTERM → stop line, EOF): interrupts the group, worker checkpoints", async () => {
    const stack = await startStack("graceful", {
      behaviour: "polite",
      heartbeatTimeoutMs: 10_000,
      graceMs: 5000,
    });
    const triggeredAt = performance.now();
    owned.signal(stack.launcher.pid ?? 0, "SIGTERM");

    const outcome = await expectWorkerGroupStopped(stack, triggeredAt);
    expect(await stack.launcherExit).toEqual({ code: 0, signal: null });
    expect(outcome.report).toMatchObject({
      ownerGone: { reason: "stop-requested" },
      exitCode: 0,
      cancelRequested: true,
      escalated: false,
    });
    // The polite worker used the interrupt to save its state before exiting.
    expect(readFileSync(join(stack.stateDir, "worker-checkpoint.txt"), "utf8")).toBe(
      "interrupted\n",
    );
    record("graceful", outcome);
  });

  it("abrupt owner exit (launcher SIGKILLed, pipe closed by the kernel): same result", async () => {
    const stack = await startStack("abrupt", {
      behaviour: "polite",
      heartbeatTimeoutMs: 10_000,
      graceMs: 5000,
    });
    const triggeredAt = performance.now();
    owned.signal(stack.launcher.pid ?? 0, "SIGKILL");
    expect(await stack.launcherExit).toEqual({ code: null, signal: "SIGKILL" });

    const outcome = await expectWorkerGroupStopped(stack, triggeredAt);
    expect(outcome.report).toMatchObject({
      ownerGone: { reason: "channel-closed" },
      cancelRequested: true,
      escalated: false,
    });
    record("abrupt", outcome);
  });

  it("hung owner (launcher frozen with SIGSTOP, pipe still open): heartbeat loss stops the group", async () => {
    const stack = await startStack("hung", {
      behaviour: "polite",
      heartbeatTimeoutMs: 1000,
      graceMs: 5000,
    });
    const triggeredAt = performance.now();
    owned.signal(stack.launcher.pid ?? 0, "SIGSTOP");
    // The pipe is NOT closed: the launcher is alive, just frozen. Only the heartbeat can tell.
    await waitFor(() => processState(stack.launcher.pid ?? 0) === "T", "the launcher to freeze");

    const outcome = await expectWorkerGroupStopped(stack, triggeredAt);
    expect(outcome.report.ownerGone).toEqual({ reason: "heartbeat-lost" });
    expect(isRunning(stack.launcher.pid ?? 0)).toBe(true); // never signalled by the runtime
    record("hung-owner", outcome);
  });

  it("the runtime itself is told to end (SIGTERM, as when wsl.exe is terminated)", async () => {
    const stack = await startStack("runtime-signal", {
      behaviour: "polite",
      heartbeatTimeoutMs: 10_000,
      graceMs: 5000,
    });
    const triggeredAt = performance.now();
    owned.signal(stack.ready.runtimePid, "SIGTERM");

    const outcome = await expectWorkerGroupStopped(stack, triggeredAt);
    expect(outcome.report.ownerGone).toEqual({ reason: "signal", signal: "SIGTERM" });
    record("runtime-sigterm", outcome);
  });

  it("a worker that ignores the interrupt is killed as a group after the grace period", async () => {
    const stack = await startStack("stubborn", {
      behaviour: "stubborn",
      heartbeatTimeoutMs: 10_000,
      graceMs: 500,
    });
    const triggeredAt = performance.now();
    owned.signal(stack.launcher.pid ?? 0, "SIGKILL");

    const outcome = await expectWorkerGroupStopped(stack, triggeredAt);
    expect(outcome.report).toMatchObject({
      ownerGone: { reason: "channel-closed" },
      signal: "SIGKILL",
      escalated: true,
    });
    expect(existsSync(join(stack.stateDir, "worker-checkpoint.txt"))).toBe(false);
    record("abrupt-stubborn-worker", outcome);
  });
});
