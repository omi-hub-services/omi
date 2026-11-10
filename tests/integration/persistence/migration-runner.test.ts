import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  checksumOf,
  loadMigrations,
  MigrationHistoryError,
  readHistory,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { runInTransaction } from "../../../src/infrastructure/persistence/sqlite/sqlite-transaction.ts";

const REPO_MIGRATIONS = resolve(import.meta.dirname, "../../../migrations");
const INITIAL = "0001-initial-state.sql";

let dir: string;
let dbPath: string;
let migrationsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-migrations-"));
  dbPath = join(dir, "state.db");
  migrationsDir = join(dir, "migrations");
  mkdirSync(migrationsDir);
  copyFileSync(join(REPO_MIGRATIONS, INITIAL), join(migrationsDir, INITIAL));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function migrate(): string[] {
  const db = openStateDatabase(dbPath);
  try {
    return applyMigrations(db, loadMigrations(migrationsDir)).applied.map((m) => m.name);
  } finally {
    db.close();
  }
}

function history() {
  const db = openStateDatabase(dbPath);
  try {
    return readHistory(db);
  } finally {
    db.close();
  }
}

describe("migration runner", () => {
  it("applies the repository migrations and records each with its checksum", () => {
    expect(migrate()).toEqual(["0001-initial-state"]);
    const sql = readFileSync(join(REPO_MIGRATIONS, INITIAL), "utf8");
    const [record, ...rest] = history();
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      version: 1,
      name: "0001-initial-state",
      checksum: checksumOf(sql),
    });
    expect(record?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("is a no-op when re-run, including after a restart", () => {
    migrate();
    const before = history();
    expect(migrate()).toEqual([]);
    expect(migrate()).toEqual([]);
    expect(history()).toEqual(before);
  });

  it("applies only the pending migrations in order", () => {
    migrate();
    writeFileSync(join(migrationsDir, "0003-third.sql"), "CREATE TABLE third (id TEXT) STRICT;");
    writeFileSync(
      join(migrationsDir, "0002-second.sql"),
      "CREATE TABLE second (id TEXT) STRICT; INSERT INTO second VALUES ('x');",
    );
    expect(migrate()).toEqual(["0002-second", "0003-third"]);
    expect(history().map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it("refuses an applied migration whose checksum changed and applies nothing", () => {
    migrate();
    const path = join(migrationsDir, INITIAL);
    writeFileSync(path, `${readFileSync(path, "utf8")}\nCREATE TABLE sneaky (id TEXT);\n`);
    writeFileSync(join(migrationsDir, "0002-second.sql"), "CREATE TABLE second (id TEXT);");

    expect(() => migrate()).toThrow(MigrationHistoryError);
    expect(() => migrate()).toThrow(/0001-initial-state changed after it was applied/);
    expect(history().map((r) => r.name)).toEqual(["0001-initial-state"]);
    const db = openStateDatabase(dbPath);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE name IN ('sneaky', 'second')")
        .all();
      expect(tables).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("treats a CRLF checkout of the same migration as unchanged", () => {
    migrate();
    const path = join(migrationsDir, INITIAL);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("\n", "\r\n"));
    expect(migrate()).toEqual([]);
  });

  it("refuses a database that records a migration the code does not know", () => {
    writeFileSync(join(migrationsDir, "0002-second.sql"), "CREATE TABLE second (id TEXT);");
    migrate();
    rmSync(join(migrationsDir, "0002-second.sql"));
    expect(() => migrate()).toThrow(/does not know/);
  });

  it("rolls back every migration of the run when one fails", () => {
    writeFileSync(join(migrationsDir, "0002-broken.sql"), "CREATE TABLE ok (id TEXT); NOT SQL;");
    expect(() => migrate()).toThrow();
    expect(history()).toEqual([]);
    const db = openStateDatabase(dbPath);
    try {
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'projects'").get()).toBe(
        undefined,
      );
    } finally {
      db.close();
    }
  });

  it("checks foreign keys before commit and restores enforcement after a failed migration", () => {
    migrate();
    writeFileSync(
      join(migrationsDir, "0002-orphan.sql"),
      `CREATE TABLE migration_parent (id TEXT PRIMARY KEY) STRICT;
       CREATE TABLE migration_child (parent_id TEXT REFERENCES migration_parent(id)) STRICT;
       INSERT INTO migration_child VALUES ('missing');`,
    );
    const db = openStateDatabase(dbPath);
    try {
      expect(() => applyMigrations(db, loadMigrations(migrationsDir))).toThrow(
        /migrations left foreign key violations/,
      );
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(readHistory(db).map((record) => record.version)).toEqual([1]);
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'migration_%'").all(),
      ).toEqual([]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("refuses nested migration without disabling foreign keys or disturbing the outer transaction", () => {
    const db = openStateDatabase(dbPath);
    try {
      runInTransaction(db, () => {
        expect(() => applyMigrations(db, loadMigrations(migrationsDir))).toThrow(
          /outside an existing transaction/,
        );
        expect(db.inTransaction).toBe(true);
        expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(readHistory(db)).toEqual([]);
      });
    } finally {
      db.close();
    }
  });

  it("rejects misnamed, duplicate or gapped migration files", () => {
    writeFileSync(join(migrationsDir, "0003-gap.sql"), "SELECT 1;");
    expect(() => loadMigrations(migrationsDir)).toThrow(/without gaps or duplicates/);
    rmSync(join(migrationsDir, "0003-gap.sql"));
    writeFileSync(join(migrationsDir, "0001-duplicate.sql"), "SELECT 1;");
    expect(() => loadMigrations(migrationsDir)).toThrow(/without gaps or duplicates/);
    rmSync(join(migrationsDir, "0001-duplicate.sql"));
    writeFileSync(join(migrationsDir, "2-Bad_Name.sql"), "SELECT 1;");
    expect(() => loadMigrations(migrationsDir)).toThrow(/NNNN-kebab-name\.sql/);
  });
});
