import type { StateDatabase } from "./sqlite-connection.js";

/**
 * Runs `work` in one short, synchronous write transaction (BEGIN IMMEDIATE) and returns its
 * result. Any throw rolls the whole transaction back. `work` must not be async: better-sqlite3
 * cannot keep a transaction open across an await, and agent/network waits never belong inside
 * one (tech-stack.md §6, design-patterns.md §6). A returned promise-like is rejected and rolled
 * back so the mistake cannot commit half a change.
 */
export function runInTransaction<T>(db: StateDatabase, work: () => T): T {
  const transaction = db.transaction(() => {
    const result = work();
    if (isPromiseLike(result)) {
      // The caller gets the TypeError below; keep the abandoned promise from crashing the process.
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError("transaction work must be synchronous; do not await inside it");
    }
    return result;
  });
  return transaction.immediate();
}

function isPromiseLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
