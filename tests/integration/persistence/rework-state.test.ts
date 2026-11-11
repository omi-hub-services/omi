import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { INITIAL_REWORK_STATE } from "../../../src/domain/runs/rework-policy.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteReworkRunReader } from "../../../src/infrastructure/persistence/sqlite/sqlite-rework-run-reader.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import type { StateChange } from "../../../src/application/ports/state-unit-of-work.ts";

it("upgrades legacy runs, preserves counters, and rolls back quality state when the audit fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "omi-rework-state-"));
  const db = openStateDatabase(join(directory, "state.db"));
  try {
    const migrations = loadMigrations(resolve("migrations"));
    applyMigrations(
      db,
      migrations.filter((migration) => migration.version < 9),
    );
    db.exec(`INSERT INTO projects VALUES ('p','repo',NULL,'h','t','t');
      INSERT INTO task_snapshots (id,project_id,issue_node_id,issue_number,content_hash,remote_updated_at,scope,captured_at) VALUES ('t','p','i',1,'h','t','{}','t');
      INSERT INTO workflow_runs (id,task_id,template_hash,status,quality_phase,failure_count,created_at,updated_at) VALUES ('r','t','h','running','implementation',1,'t','t');`);
    applyMigrations(db, migrations);
    const runs = createSqliteReworkRunReader(db);
    expect(runs.get("r")?.rework).toEqual({ ...INITIAL_REWORK_STATE, failedCycles: 1 });
    const unit = createSqliteStateUnitOfWork(db);
    const change: StateChange = {
      target: {
        kind: "workflow_run",
        id: "r",
        expectedVersion: 0,
        toStatus: "running",
        rework: {
          ...INITIAL_REWORK_STATE,
          phase: "architect",
          failedCycles: 2,
          countedCycleIds: ["c1", "c2"],
        },
      },
      at: "2026-11-11T00:00:00.000Z",
      event: {
        eventId: "event",
        kind: "rework.architect_required",
        subject: "t",
        runId: "r",
        correlationId: "r",
        payload: "{}",
      },
    };
    expect(unit.commit(change).ok).toBe(true);
    const before = runs.get("r");
    expect(unit.commit(change)).toEqual({ ok: false, reason: "STALE_VERSION" });
    expect(runs.get("r")).toEqual(before);
    expect(() =>
      unit.commit({
        ...change,
        target: {
          kind: "workflow_run",
          id: "r",
          expectedVersion: 1,
          toStatus: "blocked",
          rework: { ...INITIAL_REWORK_STATE, phase: "blocked", failedCycles: 2 },
        },
      }),
    ).toThrow(/UNIQUE/);
    expect(runs.get("r")).toEqual(before);
    expect(db.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 1 });
    // Invalid persisted lists are rejected at the read boundary, not silently reset.
    db.exec("UPDATE workflow_runs SET counted_cycle_ids='[42]'");
    expect(() => runs.get("r")).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
