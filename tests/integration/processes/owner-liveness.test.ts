import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  watchOwnerLiveness,
  type OwnerLivenessOptions,
} from "../../../src/infrastructure/processes/owner-liveness.js";

// In-memory pipe and signal source: no real process is signalled in this file.
let channel: PassThrough;
let signals: EventEmitter;

beforeEach(() => {
  channel = new PassThrough();
  signals = new EventEmitter();
});
afterEach(() => {
  vi.useRealTimers();
});

function watch(
  overrides: Partial<OwnerLivenessOptions> = {},
): ReturnType<typeof watchOwnerLiveness> {
  return watchOwnerLiveness({ channel, signalSource: signals, ...overrides });
}

describe("watchOwnerLiveness", () => {
  it("reports an abrupt exit: the owner's end of the pipe closes without a goodbye", async () => {
    const watcher = watch();
    channel.destroy();
    await expect(watcher.gone).resolves.toEqual({ reason: "channel-closed" });
  });

  it("reports EOF on the pipe", async () => {
    const watcher = watch();
    channel.end();
    await expect(watcher.gone).resolves.toEqual({ reason: "channel-closed" });
  });

  it("reports a pipe error as the owner being gone", async () => {
    const watcher = watch();
    channel.destroy(new Error("EPIPE"));
    await expect(watcher.gone).resolves.toEqual({ reason: "channel-closed" });
  });

  it("reports a channel that was already closed when the watch started", async () => {
    channel.destroy();
    const watcher = watch();
    await expect(watcher.gone).resolves.toEqual({ reason: "channel-closed" });
  });

  it("reports the graceful goodbye line, also when it arrives split across chunks", async () => {
    const watcher = watch();
    channel.write("heart");
    channel.write("beat\nst");
    channel.write("op\n");
    await expect(watcher.gone).resolves.toEqual({ reason: "stop-requested" });
  });

  it("reports the signal that ends the runtime and names it", async () => {
    const watcher = watch({ signals: ["SIGTERM", "SIGHUP"] });
    signals.emit("SIGHUP");
    await expect(watcher.gone).resolves.toEqual({ reason: "signal", signal: "SIGHUP" });
  });

  it("installs signal handlers before returning and keeps them until dispose", async () => {
    const watcher = watch({ signals: ["SIGTERM"] });
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGTERM");
    await watcher.gone;
    // A repeated signal while the worker group is being stopped must still be swallowed.
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(channel.listenerCount("data")).toBe(0);
    watcher.dispose();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("reports the first reason only", async () => {
    const watcher = watch({ signals: ["SIGTERM"] });
    signals.emit("SIGTERM");
    channel.destroy();
    await expect(watcher.gone).resolves.toEqual({ reason: "signal", signal: "SIGTERM" });
  });

  it("does not treat a hung owner as alive: silence past the timeout is heartbeat loss", async () => {
    vi.useFakeTimers();
    const watcher = watch({ heartbeatTimeoutMs: 1000 });
    let reported: unknown;
    void watcher.gone.then((gone) => (reported = gone));

    await vi.advanceTimersByTimeAsync(900);
    channel.write("heartbeat\n"); // a heartbeat restarts the clock
    await vi.advanceTimersByTimeAsync(900);
    expect(reported).toBeUndefined();

    await vi.advanceTimersByTimeAsync(200);
    expect(reported).toEqual({ reason: "heartbeat-lost" });
  });

  it("does not time out when no heartbeat timeout is configured", async () => {
    vi.useFakeTimers();
    const watcher = watch();
    let reported: unknown;
    void watcher.gone.then((gone) => (reported = gone));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(reported).toBeUndefined();
    watcher.dispose();
  });

  it("stops reporting after dispose and survives a late pipe error", async () => {
    vi.useFakeTimers();
    const watcher = watch({ heartbeatTimeoutMs: 1000, signals: ["SIGTERM"] });
    let reported: unknown;
    void watcher.gone.then((gone) => (reported = gone));
    watcher.dispose();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    channel.destroy(new Error("late"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(reported).toBeUndefined();
  });

  it("drops an over-long line instead of buffering it, and still sees a later goodbye", async () => {
    const watcher = watch();
    channel.write("x".repeat(5000));
    channel.write("\nstop\n");
    await expect(watcher.gone).resolves.toEqual({ reason: "stop-requested" });
  });
});
