import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { APPROVAL_STATUSES, type Approval } from "../../../src/domain/approvals/approval.ts";
import { RUN_STATUSES } from "../../../src/domain/runs/workflow-run.ts";
import { STEP_STATUSES } from "../../../src/domain/runs/step-run.ts";
import {
  applyMigrations,
  loadMigrations,
  readHistory,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

// Scoped to 0001-0002: later migrations have their own tests (outbox-state-constraint.test.ts).
const MIGRATIONS = loadMigrations(resolve(import.meta.dirname, "../../../migrations")).filter(
  (migration) => migration.version <= 2,
);
const DECISIONS = ["approved", "rejected"] as const satisfies readonly Approval["decision"][];
const STATE_COLUMNS = [
  { table: "workflow_runs", column: "status", allowed: RUN_STATUSES },
  { table: "approvals", column: "decision", allowed: DECISIONS },
] as const;
const PATH_COLUMNS = [
  { table: "checkpoints", column: "manifest_path" },
  { table: "artifacts", column: "relative_path" },
] as const;

let dir: string;
let db: StateDatabase;

/** Populate v1 with linked history, optional metadata, and children of rebuilt tables. */
function seed(): void {
  db.exec(`
    INSERT INTO projects VALUES ('p', 'acme/app', 'P_1', 'config', 'created', 'updated');
    INSERT INTO task_snapshots VALUES ('t', 'p', 'I_1', 1, 'content', 'remote', '{}', 'captured');
    INSERT INTO workflow_runs VALUES
      ('old', 't', NULL, 'template', 'succeeded', 'implementation', 1, 2, 'created', 'updated', 'closed'),
      ('r', 't', 'old', 'template', 'running', 'implementation', 2, 3, 'created', 'updated', NULL);
    INSERT INTO step_runs VALUES
      ('s', 'r', 'implement', 1, 'running', 'input', 'output', 4, 'created', 'updated');
    INSERT INTO agent_attempts VALUES
      ('a', 's', 1, 'codex', 'model', 'profile', 'running', 42, 'started', 5, 'started', NULL);
    INSERT INTO checkpoints VALUES
      ('c', 'r', 's', 'business', 'checkpoints/c.json', 'manifest', 'revision', 'created');
    INSERT INTO artifacts VALUES
      ('f', 'artifacts/result.json', 'content', 'a', 'internal', 'created');
    INSERT INTO approvals VALUES
      ('ap', 'r', 'release', 'subject', 'po', 'github-actor', 'approved', 'revision', 'decided', 'expiry');
    INSERT INTO outbox VALUES
      (7, 'operation', 'create-pr', 'r', 'payload', 'hash', 'pending', 2, 'PR_1', 'created', 'updated');
    INSERT INTO events VALUES
      (11, 'e', 'run.started', 'r', 'r', 'cause', 'correlation', '{}', 'occurred');
  `);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-constraints-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(
    db,
    MIGRATIONS.filter((migration) => migration.version === 1),
  );
  seed();
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function rows() {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
    )
    .all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM ${name}`).all() }));
}

function indexesAndTriggers() {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name",
    )
    .all();
}

describe("state constraint migration", () => {
  it("preserves valid rows, parent references, indexes and audit triggers and records its checksum", () => {
    const before = rows();
    const schema = indexesAndTriggers();
    const result = applyMigrations(db, MIGRATIONS);
    expect(result.applied.map((migration) => migration.name)).toEqual(["0002-state-constraints"]);
    expect(rows()).toEqual(before);
    expect(indexesAndTriggers()).toEqual(schema);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const migration = MIGRATIONS.find((entry) => entry.version === 2);
    expect(migration).toBeDefined();
    expect(readHistory(db).find((entry) => entry.version === 2)).toMatchObject({
      name: migration?.name,
      checksum: migration?.checksum,
    });
    expect(applyMigrations(db, MIGRATIONS).applied).toEqual([]);
    expect(() => db.prepare("UPDATE events SET payload = '{}'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM workflow_runs WHERE id = 'r'").run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    db.prepare(
      "INSERT INTO events (event_id, kind, subject, correlation_id, payload, occurred_at) VALUES ('e2', 'test', 'r', 'correlation', '{}', 'now')",
    ).run();
    expect(db.prepare("SELECT sequence FROM events WHERE event_id = 'e2'").get()).toEqual({
      sequence: 12,
    });
  });

  it.each(STATE_COLUMNS)(
    "accepts exactly the domain values for $table.$column",
    ({ table, column, allowed }) => {
      applyMigrations(db, MIGRATIONS);
      expectTypeOf<(typeof DECISIONS)[number]>().toEqualTypeOf<Approval["decision"]>();
      const { sql } = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table) as {
        sql: string;
      };
      const clause = new RegExp(`${column} IN \\(([^)]+)\\)`).exec(sql)?.[1] ?? "";
      const persistedValues = [...clause.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      expect(persistedValues.sort()).toEqual([...allowed].sort());
      const update = db.prepare(`UPDATE ${table} SET ${column} = ?`);
      for (const value of allowed) expect(() => update.run(value)).not.toThrow();
      const candidates = new Set([
        ...RUN_STATUSES,
        ...STEP_STATUSES,
        ...APPROVAL_STATUSES,
        "unknown",
        "",
        "RUNNING",
        "done",
      ]);
      for (const value of candidates) {
        if ((allowed as readonly string[]).includes(value)) continue;
        expect(() => update.run(value), `${table}.${column}: ${value}`).toThrow(
          /CHECK constraint failed/,
        );
      }
    },
  );

  it.each(PATH_COLUMNS)("rejects unsafe paths in $table.$column", ({ table, column }) => {
    applyMigrations(db, MIGRATIONS);
    const update = db.prepare(`UPDATE ${table} SET ${column} = ?`);
    for (const value of [
      "..",
      "../escape",
      "dir/..",
      "dir/../escape",
      "dir/../../escape",
      "/absolute",
      "C:",
      "C:relative",
      "C:/absolute",
      "c:\\absolute",
      "\\rooted",
      "\\\\server\\share",
      "dir\\..\\escape",
      "dir/..\\escape",
      "",
    ]) {
      expect(() => update.run(value), `${table}.${column}: ${value}`).toThrow(
        /CHECK constraint failed/,
      );
    }
    for (const value of ["dir/file.json", "file.json", "dir/a..b.json", "dir/.../file.json"]) {
      expect(() => update.run(value)).not.toThrow();
    }
  });

  it.each([
    { table: "workflow_runs", column: "status", value: "done" },
    { table: "approvals", column: "decision", value: "pending" },
    { table: "checkpoints", column: "manifest_path", value: "../escape" },
    { table: "artifacts", column: "relative_path", value: "C:/escape" },
  ])(
    "rolls back the rebuild when existing $table.$column is invalid",
    ({ table, column, value }) => {
      db.prepare(`UPDATE ${table} SET ${column} = ?`).run(value);
      const before = rows();
      const schema = indexesAndTriggers();
      expect(() => applyMigrations(db, MIGRATIONS)).toThrow(/CHECK constraint failed/);
      expect(rows()).toEqual(before);
      expect(indexesAndTriggers()).toEqual(schema);
      expect(readHistory(db).map((entry) => entry.version)).toEqual([1]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    },
  );
});
