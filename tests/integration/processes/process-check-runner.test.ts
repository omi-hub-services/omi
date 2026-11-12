import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createProcessCheckRunner } from "../../../src/infrastructure/processes/process-check-runner.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import type { ArtifactStore } from "../../../src/application/ports/artifact-store.ts";

const migrations = resolve(import.meta.dirname, "../../../migrations");
const node = process.execPath;

let directory: string;
let worktree: string;
let head: string;
let db: StateDatabase;
let artifacts: ArtifactStore;
let ids = 0;

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "omi-check-runner-"));
  worktree = join(directory, "worktree");
  fs.mkdirSync(worktree);
  git("init", "-q");
  fs.writeFileSync(join(worktree, "a.txt"), "a");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "init");
  head = git("rev-parse", "HEAD");
  const root = join(directory, "artifacts");
  fs.mkdirSync(root);
  db = openStateDatabase(join(directory, "state.db"));
  applyMigrations(db, loadMigrations(migrations));
  artifacts = createLocalArtifactStore(root, db);
  // The evidence artifact names its producing attempt, so the attempt row must exist.
  const at = "2026-11-10T00:00:00.000Z";
  const seed = [
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('task', 'p', 'I_1', 1, 'h', ?, '{}', ?)",
    "INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at) VALUES ('run-1', 'task', 'h', 'running', 'normal', ?, ?)",
    "INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at) VALUES ('step-1', 'run-1', 'verify', 'running', ?, ?)",
  ];
  for (const sql of seed) db.prepare(sql).run(at, at);
  db.prepare(
    "INSERT INTO agent_attempts (id, step_run_id, attempt_number, executor_id, model_id, profile_id, status, started_at) VALUES ('attempt-1', 'step-1', 1, 'claude-code', 'm', 'p', 'running', ?)",
  ).run(at);
  ids = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function runner(checks: Record<string, { command: string[]; timeoutMs?: number }>) {
  return createProcessCheckRunner({
    checks: Object.fromEntries(
      Object.entries(checks).map(([id, check]) => [
        id,
        { command: check.command, timeoutMs: check.timeoutMs ?? 20_000 },
      ]),
    ),
    artifacts,
    now: () => Date.now(),
    nextId: () => `artifact-${String(++ids)}`,
  });
}

const request = (checkId: string) => ({
  attemptId: "attempt-1",
  checkId,
  workspacePath: worktree,
  artifactRoot: "attempts/attempt-1",
});

function evidenceOf(record: { evidence: { path: string; sha256: string } }) {
  return JSON.parse(new TextDecoder().decode(artifacts.read(record.evidence))) as {
    command: string[];
    exitCode: number | null;
    startedAt: string;
    endedAt: string;
    revision: string;
    log: string;
  };
}

describe("process check runner", () => {
  it("knows exactly the configured check ids", () => {
    const r = runner({ unit: { command: [node, "-e", ""] } });
    expect(r.has("unit")).toBe(true);
    expect(r.has("lint")).toBe(false);
  });

  it("runs a passing command in the worktree and stores command, exit status, times, revision and log as an artifact", async () => {
    const r = runner({
      unit: { command: [node, "-e", "console.log('all green in ' + process.cwd())"] },
    });
    const before = Date.now();
    const record = await r.run(request("unit"));

    expect(record).toMatchObject({
      checkId: "unit",
      status: "passed",
      exitCode: 0,
      revision: head,
    });
    expect(record.evidence.path).toBe("attempts/attempt-1/checks/unit.json");
    const evidence = evidenceOf(record);
    expect(evidence.command).toEqual([node, "-e", "console.log('all green in ' + process.cwd())"]);
    expect(evidence.exitCode).toBe(0);
    expect(evidence.revision).toBe(head);
    expect(Date.parse(evidence.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(evidence.endedAt)).toBeGreaterThanOrEqual(Date.parse(evidence.startedAt));
    expect(evidence.log).toContain("all green in");
    expect(evidence.log).toContain("worktree");
    expect(record.startedAt).toBe(evidence.startedAt);
    expect(record.endedAt).toBe(evidence.endedAt);
  });

  it("records a failing exit status as failed", async () => {
    const r = runner({ unit: { command: [node, "-e", "console.error('boom'); process.exit(3)"] } });
    const record = await r.run(request("unit"));
    expect(record).toMatchObject({ status: "failed", exitCode: 3 });
    expect(evidenceOf(record).log).toContain("boom");
  });

  it("records a command that outlives its timeout as timed-out", async () => {
    const r = runner({
      slow: { command: [node, "-e", "setTimeout(() => {}, 60000)"], timeoutMs: 300 },
    });
    const record = await r.run(request("slow"));
    expect(record.status).toBe("timed-out");
  });

  it("records a command that cannot be started as failed with no exit code", async () => {
    const r = runner({ missing: { command: [join(directory, "no-such-binary")] } });
    const record = await r.run(request("missing"));
    expect(record).toMatchObject({ status: "failed", exitCode: null, revision: head });
  });

  it("stores a log with secrets redacted", async () => {
    const r = runner({
      leak: {
        command: [
          node,
          "-e",
          // Built at run time: the command text itself is stored and must stay secret-free.
          "console.log('tok' + 'en=hunter2hunter2'); console.log('Bear' + 'er abcdefghij.klmnop'); console.log('sk' + '-abcdefghijklmnopqrstuvwxyz0123456789')",
        ],
      },
    });
    const record = await r.run(request("leak"));
    const { log } = evidenceOf(record);
    expect(log).not.toContain("hunter2hunter2");
    expect(log).not.toContain("sk-abcdefghij");
    expect(log).not.toContain("abcdefghij.klmnop");
    expect(log).toContain("[REDACTED");
  });

  it("limits the stored log to a fixed size", async () => {
    const r = runner({
      noisy: { command: [node, "-e", "for (let i = 0; i < 20000; i++) console.log('line ' + i)"] },
    });
    const record = await r.run(request("noisy"));
    expect(record.status).toBe("passed");
    expect(evidenceOf(record).log.length).toBeLessThanOrEqual(16_000);
  });

  it("does not hand the runtime's environment to the command", async () => {
    vi.stubEnv("OMI_CHECK_RUNNER_PROBE", "visible-to-child");
    const r = runner({
      env: { command: [node, "-e", "console.log('probe=' + process.env.OMI_CHECK_RUNNER_PROBE)"] },
    });
    const record = await r.run(request("env"));
    expect(evidenceOf(record).log).toContain("probe=undefined");
  });

  it("throws for an id that was never configured", async () => {
    const r = runner({});
    await expect(r.run(request("unit"))).rejects.toThrow("CHECK_UNKNOWN");
  });
});
