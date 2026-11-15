import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OUTBOX_STATES } from "../../../src/domain/delivery/outbox-operation.ts";
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

const ALL = loadMigrations(resolve(import.meta.dirname, "../../../migrations")).filter(
  (migration) => migration.version <= 4,
);
// The schema this migration upgrades: 0001-0003 (0003 is the approval lifecycle of OMI-029).
const UP_TO_0003 = ALL.filter((migration) => migration.version <= 3);

let dir: string;
let db: StateDatabase;

const insert = (key: string, state: string, remote: string | null = null, attempts = 0) =>
  db
    .prepare(
      `INSERT INTO outbox (operation_key, kind, subject, payload_ref, payload_hash, state, attempt_count, remote_identity, created_at, updated_at)
       VALUES (?, 'issue.comment', 'run-1', 'payloads/p.json', ?, ?, ?, ?, 'created', 'updated')`,
    )
    .run(key, "a".repeat(64), state, attempts, remote);

const outboxRows = () => db.prepare("SELECT * FROM outbox ORDER BY id").all();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-outbox-state-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, UP_TO_0003);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("outbox state migration (0004)", () => {
  it("is the fourth migration, applies on top of the approval lifecycle and records its checksum", () => {
    const result = applyMigrations(db, ALL);
    expect(result.applied.map((migration) => migration.name)).toEqual(["0004-outbox-state"]);
    expect(readHistory(db).map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
    expect(applyMigrations(db, ALL).applied).toEqual([]);
  });

  it("keeps existing rows, ids and the unique operation key, and adds empty retry columns", () => {
    insert("op-pending", "pending");
    insert("op-done", "succeeded", "issue_comment:acme/app:7", 1);
    insert("op-flight", "in_flight", null, 2);
    const before = outboxRows();
    applyMigrations(db, ALL);
    expect(outboxRows()).toEqual(
      before.map((row) => ({ ...(row as object), next_attempt_at: null, last_error: null })),
    );
    expect(() => insert("op-pending", "pending")).toThrow(/UNIQUE constraint failed/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const index = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'outbox'")
      .all();
    expect(index).toContainEqual({ name: "outbox_state" });
  });

  it("accepts exactly the states of the domain machine", () => {
    applyMigrations(db, ALL);
    const { sql } = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'outbox'").get() as {
      sql: string;
    };
    const clause = /state IN \(([^)]+)\)/.exec(sql)?.[1] ?? "";
    const persisted = [...clause.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(persisted.sort()).toEqual([...OUTBOX_STATES].sort());

    OUTBOX_STATES.forEach((state, index) => {
      const remote = state === "succeeded" ? "issue:acme/app#1" : null;
      expect(() => insert(`ok-${String(index)}`, state, remote)).not.toThrow();
    });
    const candidates = new Set([
      ...RUN_STATUSES,
      ...STEP_STATUSES,
      "sent",
      "done",
      "retry",
      "",
      "PENDING",
    ]);
    for (const value of candidates) {
      if ((OUTBOX_STATES as readonly string[]).includes(value)) continue;
      expect(() => insert(`bad-${value}`, value), `insert state ${value}`).toThrow(
        /CHECK constraint failed/,
      );
    }
    const update = db.prepare("UPDATE outbox SET state = ? WHERE operation_key = 'ok-0'");
    expect(() => update.run("done")).toThrow(/CHECK constraint failed/);
    expect(() => update.run("failed")).not.toThrow();
  });

  it("requires a remote identity for a succeeded operation", () => {
    applyMigrations(db, ALL);
    expect(() => insert("no-identity", "succeeded", null)).toThrow(/CHECK constraint failed/);
    expect(() => insert("empty-identity", "succeeded", "")).toThrow(/CHECK constraint failed/);
    expect(() => insert("with-identity", "succeeded", "issue:acme/app#1")).not.toThrow();
  });

  it("rolls the whole migration back when an existing row has a state the domain does not know", () => {
    insert("legacy", "sent");
    const before = outboxRows();
    expect(() => applyMigrations(db, ALL)).toThrow(/CHECK constraint failed/);
    expect(outboxRows()).toEqual(before);
    expect(readHistory(db).map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const columns = db.pragma("table_info(outbox)") as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain("next_attempt_at");
  });
});
