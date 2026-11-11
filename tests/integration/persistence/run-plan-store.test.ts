import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  createSqliteRecoveryRunReader,
  createSqliteStepRunReader,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-recovery-run-reader.ts";
import { createSqliteRunPlanStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-run-plan-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";

const AT = "2026-11-11T00:00:00.000Z";
const dirs: string[] = [];
const dbs: StateDatabase[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omi-plan-store-"));
  dirs.push(dir);
  const db = openStateDatabase(join(dir, "state.db"));
  dbs.push(db);
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
  ).run(AT, AT);
  db.prepare(
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('task-35', 'p', 'I_35', 35, 'h', ?, '{}', ?)",
  ).run(AT, AT);
  return db;
}
const plan = (runId: string, suffix = "") => ({
  runId,
  taskId: "task-35",
  templateHash: "f".repeat(64),
  steps: [
    { stepRunId: `${runId}-a${suffix}`, stepId: "a", status: "ready" as const },
    { stepRunId: `${runId}-b${suffix}`, stepId: "b", status: "pending" as const },
  ],
  at: AT,
  eventId: `event-${runId}${suffix}`,
});

describe("SQLite run plan store", () => {
  it("finds the task by Issue number and creates a running run with its steps and one event", () => {
    const db = setup();
    const store = createSqliteRunPlanStore(db);
    expect(store.findTask(35)).toEqual({
      taskId: "task-35",
      projectId: "p",
      repository: "acme/app",
      issueNumber: 35,
    });
    expect(store.findTask(36)).toBeUndefined();

    expect(store.createRun(plan("run-1"))).toEqual({ ok: true });
    expect(store.forRun("run-1")).toMatchObject({
      taskId: "task-35",
      templateHash: "f".repeat(64),
    });
    const reader = createSqliteRecoveryRunReader(db);
    expect(reader.get("run-1")).toEqual({ id: "run-1", status: "running", version: 0 });
    expect(reader.listSteps("run-1").map((step) => [step.stepId, step.status])).toEqual([
      ["a", "ready"],
      ["b", "pending"],
    ]);
    expect(createSqliteStepRunReader(db).get("run-1-a")).toMatchObject({
      stepId: "a",
      runId: "run-1",
    });
    expect(createSqliteStepRunReader(db).get("nope")).toBeUndefined();
    expect(reader.listActive()).toEqual([{ id: "run-1", status: "running", version: 0 }]);
    expect(db.prepare("SELECT kind FROM events WHERE run_id = 'run-1'").all()).toEqual([
      { kind: "run.planned" },
    ]);
  });

  it("refuses a second active run for the task and writes nothing for it", () => {
    const db = setup();
    const store = createSqliteRunPlanStore(db);
    expect(store.createRun(plan("run-1"))).toEqual({ ok: true });
    expect(store.createRun(plan("run-2"))).toEqual({ ok: false, reason: "ACTIVE_RUN_EXISTS" });
    expect(createSqliteRecoveryRunReader(db).get("run-2")).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM step_runs").get()).toEqual({ n: 2 });
  });

  it("closes a finished run so the task can be planned again and `listActive` drops it", () => {
    const db = setup();
    const store = createSqliteRunPlanStore(db);
    store.createRun(plan("run-1"));
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(db),
      state: createSqliteStateUnitOfWork(db),
      owner: "runtime-1",
      now: () => Date.parse(AT),
      nextId: () => "session-event",
      leaseMs: 60_000,
    });
    const committed = session.commit({
      target: { kind: "workflow_run", id: "run-1", expectedVersion: 0, toStatus: "succeeded" },
      event: {
        eventId: "e-done",
        kind: "run.succeeded",
        subject: "run-1",
        runId: "run-1",
        correlationId: "run-1",
        payload: "{}",
      },
    });
    expect(committed).toMatchObject({ ok: true, newVersion: 1 });
    expect(
      db.prepare("SELECT closed_at AS closedAt FROM workflow_runs WHERE id = 'run-1'").get(),
    ).toEqual({
      closedAt: AT,
    });
    expect(createSqliteRecoveryRunReader(db).listActive()).toEqual([]);
    expect(store.createRun(plan("run-2"))).toEqual({ ok: true });
  });

  it("leaves a paused run open", () => {
    const db = setup();
    const store = createSqliteRunPlanStore(db);
    store.createRun(plan("run-1"));
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(db),
      state: createSqliteStateUnitOfWork(db),
      owner: "runtime-1",
      now: () => Date.parse(AT),
      nextId: () => "session-event",
      leaseMs: 60_000,
    });
    session.commit({
      target: { kind: "workflow_run", id: "run-1", expectedVersion: 0, toStatus: "paused" },
      event: {
        eventId: "e-pause",
        kind: "run.paused",
        subject: "run-1",
        runId: "run-1",
        correlationId: "run-1",
        payload: "{}",
      },
    });
    expect(
      db.prepare("SELECT closed_at AS closedAt FROM workflow_runs WHERE id = 'run-1'").get(),
    ).toEqual({
      closedAt: null,
    });
    expect(createSqliteRecoveryRunReader(db).listActive()).toMatchObject([{ status: "paused" }]);
  });
});
