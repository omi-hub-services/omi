import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { startSessionRuntime } from "../../../src/infrastructure/processes/session-runtime.ts";
import {
  startSupervisedProcess,
  type SupervisedProcess,
} from "../../../src/infrastructure/processes/supervised-process.ts";
let dir: string;
let db: StateDatabase;
let time: number;
let id: number;
const owned: SupervisedProcess[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-session-"));
  db = openStateDatabase(join(dir, "state.sqlite"));
  applyMigrations(db, loadMigrations(resolve("migrations")));
  time = Date.now();
  id = 0;
});
afterEach(async () => {
  const workers = owned.splice(0);
  for (const worker of workers) worker.cancel("SIGKILL", "group");
  await Promise.all(workers.map((worker) => worker.exit));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const claim = (owner: string, connection = db) =>
  claimProjectSession({
    leases: createSqliteLeaseStore(connection),
    state: createSqliteStateUnitOfWork(connection),
    owner,
    now: () => time,
    nextId: () => `event-${String(++id)}`,
    leaseMs: 60_000,
  });
function workerOptions(stubborn = false) {
  return {
    executable: process.execPath,
    args: [
      "-e",
      `process.on('SIGINT', () => { ${stubborn ? "" : "process.exit(0)"} }); console.log('ready'); setInterval(() => {}, 1000);`,
    ],
    cwd: dir,
    env: {},
    stdin: "",
    timeoutMs: 30_000,
    graceMs: 40,
    maxStdoutChars: 1000,
    maxLineChars: 100,
    maxStderrChars: 1000,
  };
}
describe("project session runtime", () => {
  it("refuses a competing live owner without side effects, renews and increments generation after release", () => {
    const first = claim("first");
    const other = openStateDatabase(join(dir, "state.sqlite"));
    try {
      expect(() => claim("second", other)).toThrow("PROJECT_OWNER_HELD");
    } finally {
      other.close();
    }
    time += 1000;
    expect(first.renew()).toBe(true);
    first.release();
    expect(claim("second").lease.generation).toBe(2);
  });
  it("takes an expired unreleased lease with a higher generation and rejects all old-generation writes", () => {
    const old = claim("old");
    old.record("session.started", {});
    time += 60_001;
    expect(() => {
      old.record("late", {});
    }).toThrow("LEASE_EXPIRED");
    const next = claim("next");
    expect(next.lease.generation).toBe(2);
    expect(() => {
      old.record("late", {});
    }).toThrow("STALE_LEASE");
    expect(old.renew()).toBe(false);
    expect(() => {
      old.release();
    }).toThrow("STALE_LEASE");
    expect(
      old.commit({
        target: { kind: "outbox_intent" },
        event: {
          eventId: "stale",
          kind: "late",
          subject: "p",
          correlationId: "old",
          payload: "{}",
        },
        outbox: {
          operationKey: "stale",
          kind: "test",
          subject: "p",
          payloadRef: "p",
          payloadHash: "h",
        },
      }),
    ).toEqual({ ok: false, reason: "STALE_LEASE" });
    expect(db.prepare("SELECT count(*) n FROM outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT kind FROM events").all()).toEqual([{ kind: "session.started" }]);
    next.record("next", {});
  });
  it.each(["stop", "eof", "heartbeat", "signal"])(
    "stops accepting, stops only owned groups, audits then releases on %s",
    async (trigger) => {
      const channel = new PassThrough();
      const signals = new EventEmitter();
      const session = claim("runtime");
      const stopAccepting = vi.fn(() => {
        expect(() => claim("too-early")).toThrow("PROJECT_OWNER_HELD");
        return Promise.resolve();
      });
      const runtime = await startSessionRuntime({
        session,
        owner: {
          channel,
          signalSource: signals,
          signals: ["SIGTERM"],
          ...(trigger === "heartbeat" ? { heartbeatTimeoutMs: 150 } : {}),
        },
        startAccepting: () => Promise.resolve(),
        stopAccepting,
      });
      let ready = false;
      const other = await startSupervisedProcess({
        ...workerOptions(),
        onStdoutLine: () => undefined,
      });
      owned.push(other);
      const worker = await runtime.startWorker({
        ...workerOptions(true),
        onStdoutLine: () => {
          ready = true;
        },
      });
      owned.push(worker);
      await vi.waitFor(() => {
        expect(ready).toBe(true);
      });
      writeFileSync(join(dir, "uncommitted.txt"), "keep me");
      if (trigger === "stop") channel.write("stop\n");
      if (trigger === "eof") channel.end();
      if (trigger === "signal") signals.emit("SIGTERM");
      const result = await runtime.result;
      expect(runtime.accepting).toBe(false);
      await expect(
        runtime.startWorker({ ...workerOptions(), onStdoutLine: () => undefined }),
      ).rejects.toThrow("SESSION_NOT_ACCEPTING");
      expect(result.workers).toEqual([
        expect.objectContaining({ pid: worker.pid, signal: "SIGKILL", escalated: true }),
      ]);
      expect(stopAccepting).toHaveBeenCalledOnce();
      expect(readFileSync(join(dir, "uncommitted.txt"), "utf8")).toBe("keep me");
      expect(() => process.kill(other.pid, 0)).not.toThrow();
      expect(db.prepare("SELECT kind FROM events ORDER BY sequence").all()).toEqual([
        { kind: "session.started" },
        { kind: "session.interrupted" },
      ]);
      const replacement = claim("replacement");
      expect(replacement.lease.generation).toBe(2);
    },
  );
  it("cleans up and releases ownership when IPC startup fails", async () => {
    const channel = new PassThrough();
    const runtime = await startSessionRuntime({
      session: claim("bad"),
      owner: { channel },
      startAccepting: () => Promise.reject(new Error("bind failed")),
      stopAccepting: () => Promise.resolve(),
    });
    await expect(runtime.result).rejects.toThrow("bind failed");
    expect(channel.listenerCount("data")).toBe(0);
    expect(claim("next").lease.generation).toBe(2);
  });
  it("includes a worker whose spawn is in flight when the owner closes the pipe", async () => {
    const channel = new PassThrough();
    const runtime = await startSessionRuntime({
      session: claim("race"),
      owner: { channel },
      startAccepting: () => Promise.resolve(),
      stopAccepting: () => Promise.resolve(),
    });
    const pending = runtime.startWorker({ ...workerOptions(true), onStdoutLine: () => undefined });
    channel.end();
    const worker = await pending;
    owned.push(worker);
    const result = await runtime.result;
    expect((await worker.exit).cancelRequested).toBe(true);
    expect(result.workers[0]?.pid).toBe(worker.pid);
  });

  it("stops owned workers before draining a pending resource wake-up", async () => {
    const channel = new PassThrough();
    let release: () => void = () => undefined;
    const probe = new Promise<number>((resolve) => {
      release = () => {
        resolve(0);
      };
    });
    let tick: () => void = () => undefined;
    const runtime = await startSessionRuntime({
      session: claim("resource-stop"),
      owner: { channel },
      startAccepting: () => Promise.resolve(),
      stopAccepting: () => Promise.resolve(),
      resourceWakeup: () => ({
        timing: { interval_ms: 1, max_backoff_ms: 10 },
        tick: () => probe,
        timer: {
          schedule: (callback) => {
            tick = callback;
            return () => undefined;
          },
        },
      }),
    });
    tick();
    let ready = false;
    const worker = await runtime.startWorker({
      ...workerOptions(),
      onStdoutLine: () => {
        ready = true;
      },
    });
    owned.push(worker);
    await vi.waitFor(() => {
      expect(ready).toBe(true);
    });
    channel.end();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      worker.exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          resolve(false);
        }, 1000);
      }),
    ]);
    clearTimeout(timeout);
    release();
    await runtime.result;
    expect(exited).toBe(true);
  });
});
