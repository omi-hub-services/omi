import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { SessionLaunchInput } from "../../application/contracts/session-launch.js";
import { sessionLaunchSchema } from "../../application/contracts/session-launch.js";
import { SESSION_HEARTBEAT_PERIOD_MS, SESSION_STOP_TIMEOUT_MS } from "./session-timing.js";

export type SessionSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;
interface ChildExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}
function childExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    child.once("error", () => {
      resolve({ exitCode: null, signal: null });
    });
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}
function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("child wait failed"));
      },
    );
  });
}

/** Windows holds wsl.exe's stdin. No Windows PID is interpreted in WSL. */
export async function launchWindowsSession(
  raw: SessionLaunchInput,
  options: {
    spawn?: SessionSpawn;
    signalSource?: EventEmitter;
    heartbeatPeriodMs?: number;
    stopTimeoutMs?: number;
    startupTimeoutMs?: number;
  } = {},
) {
  const input = sessionLaunchSchema.parse(raw);
  const launch = options.spawn ?? spawn;
  const signals = options.signalSource ?? process;
  const stopTimeout = options.stopTimeoutMs ?? SESSION_STOP_TIMEOUT_MS;
  const args = [
    ...(input.distribution === undefined ? [] : ["--distribution", input.distribution]),
    "--cd",
    input.projectDir,
    "--exec",
    // The project shim owns the pinned Node path; bare `node` is absent from wsl.exe's PATH under nvm.
    `${input.projectDir}/.omi-squad/bin/omi`,
    "--omi-runtime",
    input.runtimePath,
    input.projectDir,
  ];
  const runtime = launch("wsl.exe", args, { shell: false, stdio: ["pipe", "pipe", "inherit"] });
  const runtimeExit = childExit(runtime);
  const lifecycle = { stopped: false };
  let coordinator: ChildProcess | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let resolveStopped: () => void = () => undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let waitedForRuntime = false;
  const stop = () => {
    if (lifecycle.stopped) return;
    lifecycle.stopped = true;
    resolveStopped();
    clearInterval(heartbeat);
    runtime.stdin?.end("stop\n");
  };
  runtime.stdin?.on("error", stop);
  const writeHeartbeat = () => {
    // Never accumulate heartbeats behind a frozen pipe.
    if (!lifecycle.stopped && runtime.stdin?.writable && runtime.stdin.writableLength === 0)
      runtime.stdin.write("heartbeat\n");
  };
  const ready = new Promise<boolean>((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) {
        const line = buffer.slice(0, buffer.indexOf("\n"));
        runtime.stdout?.off("data", onData);
        resolve(line === "ready");
      } else if (buffer.length > 1024) {
        runtime.stdout?.off("data", onData);
        resolve(false);
      }
    };
    runtime.stdout?.on("data", onData);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) signals.on(signal, stop);
  let runtimeStopped = false;
  try {
    writeHeartbeat();
    heartbeat = setInterval(
      writeHeartbeat,
      options.heartbeatPeriodMs ?? SESSION_HEARTBEAT_PERIOD_MS,
    );
    const isReady = await bounded(
      Promise.race([ready, runtimeExit.then(() => false), stoppedPromise.then(() => false)]),
      options.startupTimeoutMs ?? 30_000,
    );
    if (isReady !== true || lifecycle.stopped) throw new Error("RUNTIME_START_FAILED");
    coordinator = launch(input.coordinator, [], { shell: false, stdio: "inherit" });
    const coordinatorExit = childExit(coordinator);
    const winner = await Promise.race([
      coordinatorExit.then((exit) => ({ source: "coordinator" as const, exit })),
      runtimeExit.then((exit) => ({ source: "runtime" as const, exit })),
      stoppedPromise.then(() => ({ source: "stop" as const })),
    ]);
    stop();
    if (winner.source !== "coordinator") coordinator.kill("SIGTERM");
    const exit = await bounded(coordinatorExit, stopTimeout);
    if (exit === undefined) coordinator.kill("SIGKILL");
    const runtimeResult = await bounded(runtimeExit, stopTimeout);
    waitedForRuntime = true;
    runtimeStopped = runtimeResult !== undefined && runtimeResult.exitCode === 0;
    return { exitCode: winner.source === "runtime" ? 1 : (exit?.exitCode ?? null), runtimeStopped };
  } finally {
    stop();
    if (!runtimeStopped) {
      const exit = waitedForRuntime ? undefined : await bounded(runtimeExit, stopTimeout);
      // Killing this relay is a last resort; it is not proof that WSL workers stopped.
      if (exit === undefined) {
        runtime.kill("SIGKILL");
        runtime.stdin?.destroy();
        runtime.stdout?.destroy();
        runtime.unref();
      }
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) signals.off(signal, stop);
  }
}
