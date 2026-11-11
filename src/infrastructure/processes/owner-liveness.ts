import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

/**
 * Why the owner (the Coordinator side) is considered gone (ADR-0028):
 * - `channel-closed`: EOF, close or error on the pipe the owner holds. This is what an abrupt
 *   owner exit looks like, because the kernel (or wsl.exe) closes the owner's end of the pipe.
 * - `stop-requested`: the owner wrote a `stop` line, the graceful path.
 * - `heartbeat-lost`: the pipe is still open but nothing arrived within `heartbeatTimeoutMs`,
 *   so the owner is hung or frozen.
 * - `signal`: the runtime itself was asked to end (SIGTERM, SIGHUP, ...), `signal` says which.
 */
export type OwnerGoneReason = "channel-closed" | "stop-requested" | "heartbeat-lost" | "signal";

export interface OwnerGone {
  reason: OwnerGoneReason;
  signal?: NodeJS.Signals;
}

export interface OwnerLivenessOptions {
  /**
   * The pipe the owner holds: the runtime's stdin. Across the Windows/WSL2 boundary the holder is
   * a long-lived `wsl.exe` child of the Windows launcher (ADR-0012). Liveness is never read from
   * a PID, because WSL2 cannot see Windows PIDs.
   */
  channel: Readable;
  /** Silence on the channel for longer than this means the owner is gone. Omit to rely on EOF. */
  heartbeatTimeoutMs?: number;
  /** Signals that mean the owner is going away. Handlers are installed before this returns. */
  signals?: readonly NodeJS.Signals[];
  /** Where signal handlers are installed; defaults to the real `process`. */
  signalSource?: EventEmitter;
}

export interface OwnerLivenessWatch {
  /** Resolves once, with the first thing that shows the owner is gone. */
  readonly gone: Promise<OwnerGone>;
  /**
   * Removes every listener and timer. Call it when the run ends for another reason; `gone` then
   * never resolves.
   */
  dispose(): void;
}

/** A line longer than this is garbage; it is dropped instead of buffered without bound. */
const MAX_LINE_CHARS = 1024;
const STOP_LINE = "stop";

/**
 * Watches the owner through the channel it holds. Line protocol on the channel: `stop` is a
 * graceful goodbye, any other line is a heartbeat. Every handler is installed synchronously, so a
 * caller can announce readiness right after this returns without a window in which an owner exit
 * or a signal would be missed.
 */
export function watchOwnerLiveness(options: OwnerLivenessOptions): OwnerLivenessWatch {
  const signalSource = options.signalSource ?? process;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let buffer = "";
  let settled = false;
  let resolveGone: (gone: OwnerGone) => void = () => undefined;
  const gone = new Promise<OwnerGone>((resolve) => {
    resolveGone = resolve;
  });

  const dispose = (): void => {
    clearTimeout(heartbeatTimer);
    for (const [signal, handler] of signalHandlers) signalSource.off(signal, handler);
    signalHandlers.clear();
    options.channel.off("data", onData);
    options.channel.off("end", onClosed);
    options.channel.off("close", onClosed);
    // A late 'error' on a channel nobody watches any more must not crash the process.
    options.channel.on("error", () => undefined);
  };

  const settle = (result: OwnerGone): void => {
    if (settled) return;
    settled = true;
    dispose();
    resolveGone(result);
  };

  function armHeartbeat(): void {
    if (options.heartbeatTimeoutMs === undefined) return;
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(
      () => settle({ reason: "heartbeat-lost" }),
      options.heartbeatTimeoutMs,
    );
  }

  function onData(chunk: string | Buffer): void {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === STOP_LINE) {
        settle({ reason: "stop-requested" });
        return;
      }
      armHeartbeat();
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LINE_CHARS) buffer = "";
  }

  function onClosed(): void {
    settle({ reason: "channel-closed" });
  }

  for (const signal of options.signals ?? []) {
    const handler = (): void => settle({ reason: "signal", signal });
    signalHandlers.set(signal, handler);
    signalSource.on(signal, handler);
  }
  options.channel.on("data", onData);
  options.channel.on("end", onClosed);
  options.channel.on("close", onClosed);
  options.channel.on("error", onClosed);
  if (options.channel.destroyed) onClosed();
  armHeartbeat();

  return {
    gone,
    dispose: () => {
      settled = true;
      dispose();
    },
  };
}
