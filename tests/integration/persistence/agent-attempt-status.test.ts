import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { AGENT_ATTEMPT_STATUSES } from "../../../src/domain/runs/agent-attempt.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
  readHistory,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
// This suite pins migration 0005 without incorporating later additive schema changes.
const migrations = loadMigrations(resolve("migrations")).filter(
  (migration) => migration.version <= 5,
);
let dir: string;
let db: StateDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-attempt-"));
  db = openStateDatabase(join(dir, "state.sqlite"));
  applyMigrations(
    db,
    migrations.filter((migration) => migration.version <= 4),
  );
  db.exec(`INSERT INTO projects VALUES ('p','repo',NULL,'h','t','t');
    INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('t','p','i',1,'h','t','{}','t');
    INSERT INTO workflow_runs (id,task_id,template_hash,status,quality_phase,created_at,updated_at) VALUES ('r','t','h','running','implementation','t','t');
    INSERT INTO step_runs (id,run_id,step_key,status,created_at,updated_at) VALUES ('s','r','k','running','t','t');`);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function insert(id: string, status: string, attempt = 1) {
  db.prepare(
    `INSERT INTO agent_attempts (id, step_run_id, attempt_number, executor_id, model_id, profile_id, status, process_pid, process_started_at, process_generation, started_at)
    VALUES (?, 's', ?, 'codex', 'model', 'profile', ?, 123, 'process-start', 1, 'attempt-start')`,
  ).run(id, attempt, status);
}
describe("agent_attempts status migration 0005", () => {
  it("preserves existing attempts and incoming artifact references, indexes and constraints", () => {
    insert("old", "running");
    db.exec(
      `INSERT INTO artifacts (id,relative_path,content_hash,producer_attempt_id,classification,created_at) VALUES ('artifact','outputs/a','h','old','internal','t')`,
    );
    const before = db.prepare("SELECT * FROM agent_attempts").all();
    expect(applyMigrations(db, migrations).applied.map((migration) => migration.name)).toEqual([
      "0005-agent-attempt-status",
    ]);
    expect(db.prepare("SELECT * FROM agent_attempts").all()).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => db.prepare("DELETE FROM agent_attempts").run()).toThrow(/FOREIGN KEY/);
    expect(() => {
      insert("duplicate", "failed");
    }).toThrow(/UNIQUE/);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name='agent_attempts_profile'",
        )
        .get(),
    ).toBeDefined();
    expect(applyMigrations(db, migrations).applied).toEqual([]);
  });
  it("accepts exactly the domain vocabulary and rejects invalid inserts and updates", () => {
    applyMigrations(db, migrations);
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name='agent_attempts'").get() as {
      sql: string;
    };
    const clause = /status IN \(([^)]+)\)/.exec(row.sql)?.[1] ?? "";
    expect([...clause.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()).toEqual(
      [...AGENT_ATTEMPT_STATUSES].sort(),
    );
    AGENT_ATTEMPT_STATUSES.forEach((status, index) => {
      insert(status, status, index + 1);
    });
    for (const status of ["done", "ready", "paused", "", "RUNNING"])
      expect(() => {
        insert("bad", status, 99);
      }).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE agent_attempts SET status='done'").run()).toThrow(/CHECK/);
  });
  it("rolls back rather than rewriting invalid legacy data", () => {
    insert("legacy", "done");
    expect(() => applyMigrations(db, migrations)).toThrow(/CHECK/);
    expect(db.prepare("SELECT status FROM agent_attempts").get()).toEqual({ status: "done" });
    expect(readHistory(db).map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
