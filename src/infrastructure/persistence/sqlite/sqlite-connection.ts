import Database from "better-sqlite3";

/** Default time a writer waits for a lock before SQLITE_BUSY (tech-stack.md §6: finite). */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface OpenStateDatabaseOptions {
  /** Finite lock wait in milliseconds; must be a positive integer. */
  readonly busyTimeoutMs?: number;
}

export type StateDatabase = Database.Database;

/**
 * Opens (creating if needed) the state database file with the durability settings required by
 * tech-stack.md §6: foreign keys on, WAL journal, synchronous FULL and a finite busy timeout.
 * Each setting is read back and the connection is closed with an error if SQLite did not
 * accept it (for example WAL on a file system that cannot hold the shared-memory index).
 */
export function openStateDatabase(
  filePath: string,
  options: OpenStateDatabaseOptions = {},
): StateDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
    throw new RangeError(`busyTimeoutMs must be a positive integer, got ${String(busyTimeoutMs)}`);
  }
  if (filePath === "" || filePath === ":memory:") {
    throw new RangeError("the state database must be a file: WAL and restart need one");
  }

  const db = new Database(filePath, { timeout: busyTimeoutMs });
  try {
    db.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    assertPragma(db, "foreign_keys", 1);
    assertPragma(db, "journal_mode", "wal");
    assertPragma(db, "synchronous", SYNCHRONOUS_FULL);
    assertPragma(db, "busy_timeout", busyTimeoutMs);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Opens an existing state database for reading only, for views (`status`, `watch`) that run beside
 * the runtime. It sets no journal mode (the runtime owns WAL), cannot write, and never creates a
 * file, so a mistyped path is an error and not an empty database.
 */
export function openReadOnlyStateDatabase(
  filePath: string,
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): StateDatabase {
  return new Database(filePath, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
}

/** PRAGMA synchronous reports FULL as 2. */
const SYNCHRONOUS_FULL = 2;

function assertPragma(db: StateDatabase, name: string, expected: string | number): void {
  const actual: unknown = db.pragma(name, { simple: true });
  if (actual !== expected) {
    throw new Error(
      `SQLite refused PRAGMA ${name}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}
