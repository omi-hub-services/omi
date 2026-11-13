import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
/** Starts the entry point with stdin left open, as the Windows launcher does. */
function startFailing(projectDir: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      resolve("tools/register-ts-imports.ts"),
      resolve("src/bootstrap/runtime.ts"),
      projectDir,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  return { exit, stderr: () => stderr };
}
const VALID_PROJECT = `schema_version: 1
repository: { owner: acme, name: app }
project: { owner: acme, number: 1 }
branches: { integration: develop, release: main }
limits: { max_parallel_workers: 2, step_timeout_seconds: 60, max_rework_cycles: 2 }
policies: { mandatory_approvals: [] }
`;
function writeConfig(models: string) {
  const config = join(dir, ".omi-squad", "config");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "project.yaml"), VALID_PROJECT);
  writeFileSync(join(config, "models.yaml"), models);
}
describe("runtime startup failure", () => {
  it("maps an unparsable models file to CONFIG_INVALID with its fixed code", async () => {
    writeConfig("models: [unterminated\n");
    const failed = startFailing(dir);
    expect(await failed.exit).toBe(1);
    expect(failed.stderr()).toContain("[CONFIG_INVALID]: INVALID_MODELS_CONFIG");
    expect(failed.stderr()).not.toContain("unterminated");
  }, 10000);

  it("reports a GitWorkspaceError code when the project is not a git checkout", async () => {
    writeConfig(`schema_version: 1
models:
  worker: { executor: claude-code, model: worker, supported_efforts: [medium] }
capability_profiles: { standard: { min_effort: medium } }
verified_models: { standard: [worker] }
`);
    const squad = join(dir, ".omi-squad");
    for (const path of ["roles", "rules", "workflows", "provenance"])
      mkdirSync(join(squad, path), { recursive: true });
    writeFileSync(join(squad, "provenance/skills.lock.json"), JSON.stringify({ skills: [] }));
    const failed = startFailing(dir);
    expect(await failed.exit).toBe(1);
    expect(failed.stderr()).toContain("[GIT_WORKSPACE_FAILED]: GIT_FAILED");
  }, 10000);

  it("never prints a token-shaped models map key", async () => {
    writeConfig(`schema_version: 1
models:
  glpat-xxxxxxxxxxxxxxxxxxxx: { executor: nope }
capability_profiles: { standard: { min_effort: medium } }
verified_models: { standard: [] }
`);
    const failed = startFailing(dir);
    expect(await failed.exit).toBe(1);
    expect(failed.stderr()).toContain("[CONFIG_INVALID]");
    expect(failed.stderr()).not.toContain("glpat");
  }, 10000);

  it("does not echo an unknown model alias from a models config issue", async () => {
    writeConfig(`schema_version: 1
models:
  worker: { executor: claude-code, model: worker, supported_efforts: [medium] }
capability_profiles: { standard: { min_effort: medium } }
verified_models: { standard: [private-corp-alias] }
`);
    const failed = startFailing(dir);
    expect(await failed.exit).toBe(1);
    expect(failed.stderr()).toContain("[CONFIG_INVALID]");
    expect(failed.stderr()).toContain("unknown model alias");
    expect(failed.stderr()).not.toContain("private-corp-alias");
  }, 10000);

  it("prints a classified path error and exits while stdin stays open", async () => {
    const failed = startFailing("relative/dir");
    expect(await failed.exit).toBe(1);
    expect(failed.stderr()).toContain("[PATH_INVALID]");
    expect(failed.stderr()).not.toContain("session runtime failed");
  }, 10000);

  it("prints config issue paths without file contents and exits while stdin stays open", async () => {
    const config = join(dir, ".omi-squad", "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "project.yaml"), "schema_version: 1\nrepository: nope\n");
    const failed = startFailing(dir);
    expect(await failed.exit).toBe(1);
    expect(failed.stderr()).toContain("[CONFIG_INVALID]");
    expect(failed.stderr()).toContain("repository:");
    expect(failed.stderr()).not.toContain("nope");
    expect(failed.stderr()).not.toMatch(/\bat .*\(/);
  }, 10000);

  it("reports a credential-bearing config by code without echoing the value", async () => {
    const config = join(dir, ".omi-squad", "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "project.yaml"),
      "schema_version: 1\nrepository: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
    );
    const failed = startFailing(dir);
    expect(await failed.exit).toBe(1);
    expect(failed.stderr()).toContain("[CONFIG_INVALID]");
    expect(failed.stderr()).toContain("CREDENTIAL_INPUT");
    expect(failed.stderr()).not.toContain("ghp_");
  }, 10000);
});
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
