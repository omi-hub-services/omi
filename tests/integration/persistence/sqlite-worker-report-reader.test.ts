import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteWorkerReportReader } from "../../../src/infrastructure/persistence/sqlite/sqlite-worker-report-reader.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { dispatchStep } from "../../../src/application/use-cases/runs/dispatch-step.ts";
import { readWorkerReport } from "../../../src/application/use-cases/runs/read-worker-report.ts";
import { dispatchInput, rig } from "../../unit/application/use-cases/runs/run-fakes.ts";

it("reads a startup failure dispatched into SQLite as a failure report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-worker-startup-report-"));
  const db = openStateDatabase(join(dir, "state.sqlite"));
  try {
    applyMigrations(db, loadMigrations(resolve("migrations")));
    db.exec(`
      INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at)
        VALUES ('p', 'acme/app', 'h', 't', 't');
      INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at)
        VALUES ('task', 'p', 'I_1', 1, 'h', 't', '{}', 't');
      INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at)
        VALUES ('run-1', 'task', 'h', 'running', 'normal', 't', 't');
      INSERT INTO step_runs (id, run_id, step_key, status, version, created_at, updated_at)
        VALUES ('step-1', 'run-1', 'implement', 'ready', 1, 't', 't');
      INSERT INTO leases (resource_key, owner, generation, acquired_at, expires_at)
        VALUES ('worktree:omi-017', 'worker-1', 1, '2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z');
    `);
    const r = rig();
    r.executor.failStart = true;
    expect(
      await dispatchStep(
        { ...r.deps, unitOfWork: createSqliteStateUnitOfWork(db) },
        dispatchInput(),
      ),
    ).toEqual({ ok: false, reason: "EXECUTOR_START_FAILED", detail: "SPAWN_FAILED" });
    expect(
      readWorkerReport(
        { attempts: r.attempts, reports: createSqliteWorkerReportReader(db) },
        { attemptId: "id-1" },
      ),
    ).toMatchObject({
      ok: true,
      status: "failed",
      report: { outcome: "failed", exitCode: null, failure: "SPAWN_FAILED" },
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reads only the selected attempt's newest recorded completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-worker-report-"));
  const db = openStateDatabase(join(dir, "state.sqlite"));
  try {
    applyMigrations(db, loadMigrations(resolve("migrations")));
    const insert = db.prepare(
      "INSERT INTO events(event_id, kind, subject, correlation_id, payload, occurred_at) VALUES (?, ?, 'step', ?, ?, '2026-11-12T00:00:00.000Z')",
    );
    insert.run("e1", "step.failed", "a", JSON.stringify({ outcome: "failed", exitCode: 1 }));
    insert.run("e2", "step.succeeded", "b", JSON.stringify({ outcome: "succeeded", exitCode: 0 }));
    insert.run("e3", "step.running", "a", "{}");
    const reader = createSqliteWorkerReportReader(db);
    expect(reader.read("a")).toEqual({ outcome: "failed", exitCode: 1 });
    expect(reader.read("b")).toEqual({ outcome: "succeeded", exitCode: 0 });
    expect(reader.read("unknown")).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
