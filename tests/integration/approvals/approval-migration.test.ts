import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  loadMigrations,
  readHistory,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteApprovalStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

const migrations = loadMigrations(resolve(import.meta.dirname, "../../../migrations"));
let dir: string;
let db: StateDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-approval-migration-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(
    db,
    migrations.filter((migration) => migration.version <= 2),
  );
  db.exec(`INSERT INTO approvals VALUES
    ('accepted', NULL, 'business', 'baseline', 'po', 'po-cli', 'approved', 'revision', 'decided', NULL),
    ('declined', NULL, 'cost', 'estimate', 'po', 'github-actor', 'rejected', 'revision', 'decided', 'expiry')`);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("approval lifecycle migration", () => {
  it("preserves legacy decisions and indexes, but does not invent missing subject provenance", () => {
    expect(applyMigrations(db, migrations).applied.map((entry) => entry.name)).toEqual([
      "0003-approval-lifecycle",
    ]);
    expect(
      db
        .prepare(
          "SELECT id, actor, channel, decision, status, version, request_json FROM approvals ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "accepted",
        actor: "po",
        channel: "po-cli",
        decision: "approved",
        status: "approved",
        version: 0,
        request_json: null,
      },
      {
        id: "declined",
        actor: "po",
        channel: "github-actor",
        decision: "rejected",
        status: "rejected",
        version: 0,
        request_json: null,
      },
    ]);
    expect(createSqliteApprovalStore(db).get("accepted")).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'approvals_%' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "approvals_run" }, { name: "approvals_subject" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
    db = openStateDatabase(join(dir, "state.db"));
    expect(applyMigrations(db, migrations).applied).toEqual([]);
    expect(readHistory(db).find((entry) => entry.version === 3)?.checksum).toBe(
      migrations.find((entry) => entry.version === 3)?.checksum,
    );
  });

  it("enforces decision/lifecycle consistency, known states, nonnegative versions and JSON", () => {
    applyMigrations(db, migrations);
    for (const sql of [
      "UPDATE approvals SET status='pending' WHERE id='accepted'",
      "UPDATE approvals SET decision=NULL WHERE id='accepted'",
      "UPDATE approvals SET status='rejected' WHERE id='accepted'",
      "UPDATE approvals SET status='unknown' WHERE id='accepted'",
      "UPDATE approvals SET version=-1 WHERE id='accepted'",
      "UPDATE approvals SET request_json='broken' WHERE id='accepted'",
    ])
      expect(() => db.exec(sql)).toThrow(/CHECK/);
  });
});
