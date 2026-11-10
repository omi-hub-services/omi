import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectRuntime } from "../application/use-cases/project/inspect-runtime.js";
import type { RuntimeIdentity } from "../application/use-cases/project/inspect-runtime.js";
import type { CliEnvironment } from "../interfaces/cli/commands/create-program.js";
import { createCommandDispatcher } from "../interfaces/ipc/command-dispatcher.js";
import { sendCommand } from "../interfaces/ipc/ipc-client.js";
import { createIpcServer } from "../interfaces/ipc/ipc-server.js";
import type { IpcServer } from "../interfaces/ipc/ipc-server.js";

/** Where the runtime listens for a project (architecture.md §4: `.omi-squad/local/ipc/`). */
export function defaultSocketPath(projectDir: string): string {
  return join(projectDir, ".omi-squad", "local", "ipc", "runtime.sock");
}

/** The package version, read once at start-up (the same file for `src/` and for `dist/`). */
export function readPackageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  throw new Error("package.json has no string version");
}

export interface CliWiringOptions {
  readonly socketPath: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly timeoutMs?: number;
}

/** Wires the CLI to the real IPC client. Used by `cli.ts`; tests may pass their own environment. */
export function createCliEnvironment(options: CliWiringOptions): CliEnvironment {
  return {
    sendCommand,
    defaultSocketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? 5_000,
    version: readPackageVersion(),
    stdout: options.stdout,
    stderr: options.stderr,
  };
}

/**
 * Wires the runtime side: IPC server → dispatcher → use cases. It does not start a process or
 * decide when to stop; the runtime lifecycle belongs to OMI-016.
 */
export function createRuntimeIpcServer(options: {
  readonly socketPath: string;
  readonly identity: RuntimeIdentity;
  readonly idleTimeoutMs?: number;
}): IpcServer {
  return createIpcServer({
    socketPath: options.socketPath,
    handler: createCommandDispatcher({ inspectRuntime: () => inspectRuntime(options.identity) }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
}
