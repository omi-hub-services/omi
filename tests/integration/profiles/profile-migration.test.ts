import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteProfileRegistry } from "../../../src/infrastructure/profiles/sqlite-profile-registry.ts";

it("upgrades legacy rows without inferring models, efforts or readiness", () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-profile-migration-"));
  const db = openStateDatabase(join(dir, "state.sqlite"));
  try {
    const migrations = loadMigrations(resolve("migrations"));
    applyMigrations(
      db,
      migrations.filter((migration) => migration.version <= 5),
    );
    db.exec(`INSERT INTO projects VALUES ('p','repo',NULL,'h','t','t');
      INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('t','p','i',1,'h','t','{}','t');
      INSERT INTO workflow_runs (id,task_id,template_hash,status,quality_phase,created_at,updated_at) VALUES ('r','t','h','running','implementation','t','t');
      INSERT INTO step_runs (id,run_id,step_key,status,created_at,updated_at) VALUES ('s','r','k','ready','t','t');
      INSERT INTO agent_attempts (id,step_run_id,attempt_number,executor_id,model_id,profile_id,status,started_at)
      VALUES ('old','s',1,'codex','legacy-model','legacy-profile','succeeded','t');
      INSERT INTO profile_observations (profile_id,availability,source,observed_at)
      VALUES ('legacy-profile','ready','old-probe','t');`);
    expect(applyMigrations(db, migrations).applied.map((entry) => entry.name)).toEqual([
      "0006-profile-registry",
    ]);
    expect(
      db
        .prepare(
          "SELECT model_id,chosen_effort,actual_model,actual_effort,status FROM agent_attempts",
        )
        .get(),
    ).toEqual({
      model_id: "legacy-model",
      chosen_effort: null,
      actual_model: null,
      actual_effort: null,
      status: "succeeded",
    });
    expect(db.prepare("SELECT metadata_json,availability FROM profile_observations").get()).toEqual(
      { metadata_json: null, availability: "ready" },
    );
    expect(createSqliteProfileRegistry(db).list()).toEqual([]);
    for (const column of ["chosen_effort", "actual_effort"]) {
      expect(() => db.prepare(`UPDATE agent_attempts SET ${column}='ultra'`).run()).toThrow(
        /CHECK/,
      );
    }
    expect(() =>
      db.prepare("UPDATE profile_observations SET metadata_json='not-json'").run(),
    ).toThrow(/CHECK/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(applyMigrations(db, migrations).applied).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
