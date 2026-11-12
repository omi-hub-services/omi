import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { sendCommand } from "../../../src/interfaces/ipc/ipc-client.ts";
let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-entry-"));
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
function start() {
  const child = spawn(
    process.execPath,
    ["--import", resolve("tools/register-ts-imports.ts"), resolve("src/bootstrap/runtime.ts"), dir],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  return { child, exit, ready: () => output.includes("ready\n") };
}
describe("runtime executable composition", () => {
  it("owns the project before binding IPC, refuses a second start and releases after graceful stop", async () => {
    const first = start();
    await vi.waitFor(
      () => {
        expect(first.ready()).toBe(true);
      },
      { timeout: 5000 },
    );
    const socketPath = join(dir, ".omi-squad/local/ipc/runtime.sock");
    expect(
      await sendCommand({
        socketPath,
        command: { schemaVersion: 1, command: "status" },
        timeoutMs: 1000,
      }),
    ).toMatchObject({ ok: true, result: { state: "ready" } });
    const second = start();
    expect(await second.exit).toBe(1);
    first.child.stdin.end("stop\n");
    expect(await first.exit).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
    const db = openStateDatabase(join(dir, ".omi-squad/local/state/state.sqlite"));
    try {
      expect(db.prepare("SELECT kind FROM events ORDER BY sequence").all()).toEqual([
        { kind: "session.started" },
        { kind: "session.interrupted" },
      ]);
      expect(
        db.prepare("SELECT generation, acquired_at = expires_at AS released FROM leases").get(),
      ).toEqual({ generation: 1, released: 1 });
    } finally {
      db.close();
    }
    const third = start();
    await vi.waitFor(
      () => {
        expect(third.ready()).toBe(true);
      },
      { timeout: 5000 },
    );
    third.child.stdin.destroy();
    expect(await third.exit).toBe(0);
    // Three real runtime processes in a row: the 5 s default is too tight under a parallel run.
  }, 20000);
});
