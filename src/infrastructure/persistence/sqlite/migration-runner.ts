import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

/** One numbered SQL migration file, e.g. `0001-initial-state.sql`. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** SHA-256 hex digest of the SQL with line endings normalised to LF. */
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  readonly applied: readonly Migration[];
}

/** Raised when the migration files and the recorded history disagree; nothing is applied. */
export class MigrationHistoryError extends Error {
  override readonly name = "MigrationHistoryError";
}

export const MIGRATION_HISTORY_TABLE = "schema_migrations";

const MIGRATION_FILE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;

/**
 * Reads the numbered `.sql` files of `directory` in version order. Other files (such as
 * `.gitkeep`) are ignored; a `.sql` file with a bad name, a duplicate version or a gap in the
 * sequence is an error, so a misnamed migration cannot be skipped silently.
 */
export function loadMigrations(directory: string): Migration[] {
  const migrations: Migration[] = [];
  for (const fileName of readdirSync(directory).sort()) {
    if (!fileName.endsWith(".sql")) continue;
    const match = MIGRATION_FILE.exec(fileName);
    const [, digits, slug] = match ?? [];
    if (digits === undefined || slug === undefined) {
      throw new MigrationHistoryError(
        `${fileName}: migration files must be named NNNN-kebab-name.sql`,
      );
    }
    const sql = readFileSync(join(directory, fileName), "utf8");
    migrations.push({
      version: Number(digits),
      name: `${digits}-${slug}`,
      sql,
      checksum: checksumOf(sql),
    });
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationHistoryError(
        `${migration.name}: expected version ${String(index + 1)}; versions must run 0001, 0002, … without gaps or duplicates`,
      );
    }
  });
  return migrations;
}

/** Checksum of migration SQL; CRLF and LF checkouts of the same file hash the same. */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
}

/**
 * Applies every pending migration in version order and records each one in
 * `schema_migrations` with its checksum. Runs in one BEGIN IMMEDIATE transaction, so a second
 * process waits instead of racing, and a failing migration leaves the database unchanged.
 *
 * Refuses (MigrationHistoryError, nothing applied) when an applied migration's checksum or name
 * changed, or when the database records a migration this code does not know (a newer schema).
 * Re-running with nothing pending is a no-op. Foreign key enforcement is disabled outside the
 * transaction for table rebuilds, checked before commit and restored on success or failure.
 * Calling from an existing transaction is refused before changing connection settings.
 */
export function applyMigrations(
  db: StateDatabase,
  migrations: readonly Migration[],
): MigrationResult {
  // SQLite ignores foreign_keys changes inside a transaction. Rebuilds must temporarily
  // disable enforcement before BEGIN; foreign_key_check below validates before commit.
  if (db.inTransaction) {
    throw new MigrationHistoryError("migrations must run outside an existing transaction");
  }
  try {
    setForeignKeys(db, false);
    return runInTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_HISTORY_TABLE} (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT`);

      const applied = readHistory(db);
      const known = new Map(migrations.map((m) => [m.version, m]));
      for (const record of applied) {
        const migration = known.get(record.version);
        if (migration === undefined) {
          throw new MigrationHistoryError(
            `database has migration ${record.name} that this version does not know; refusing to run an older omi-squad against a newer schema`,
          );
        }
        if (migration.name !== record.name || migration.checksum !== record.checksum) {
          throw new MigrationHistoryError(
            `migration ${record.name} changed after it was applied (recorded checksum ${record.checksum}, file ${migration.name} has ${migration.checksum}); never edit an applied migration, add a new one`,
          );
        }
      }

      const appliedVersions = new Set(applied.map((record) => record.version));
      const pending = [...migrations]
        .sort((a, b) => a.version - b.version)
        .filter((m) => !appliedVersions.has(m.version));
      const record = db.prepare(
        `INSERT INTO ${MIGRATION_HISTORY_TABLE} (version, name, checksum) VALUES (?, ?, ?)`,
      );
      for (const migration of pending) {
        db.exec(migration.sql);
        record.run(migration.version, migration.name, migration.checksum);
      }

      const violations = db.pragma("foreign_key_check");
      if (Array.isArray(violations) && violations.length > 0) {
        throw new MigrationHistoryError(
          `migrations left foreign key violations: ${JSON.stringify(violations)}`,
        );
      }
      return { applied: pending };
    });
  } finally {
    setForeignKeys(db, true);
  }
}

function setForeignKeys(db: StateDatabase, enabled: boolean): void {
  db.pragma(`foreign_keys = ${enabled ? "ON" : "OFF"}`);
  if (db.pragma("foreign_keys", { simple: true }) !== (enabled ? 1 : 0)) {
    throw new MigrationHistoryError(
      `SQLite refused to ${enabled ? "restore" : "disable"} foreign keys for migrations`,
    );
  }
}

/** The recorded migration history in version order; empty before the first migration. */
export function readHistory(db: StateDatabase): AppliedMigration[] {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(MIGRATION_HISTORY_TABLE);
  if (exists === undefined) return [];
  const rows = db
    .prepare(
      `SELECT version, name, checksum, applied_at FROM ${MIGRATION_HISTORY_TABLE} ORDER BY version`,
    )
    .all() as { version: number; name: string; checksum: string; applied_at: string }[];
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}
