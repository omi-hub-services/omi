import { isAsyncFunction } from "node:util/types";
import type { StateDatabase } from "./sqlite-connection.js";

/**
 * Runs `work` in one short, synchronous write transaction (BEGIN IMMEDIATE) and returns its
 * result. Any throw rolls the whole transaction back. `work` must not be async: better-sqlite3
 * cannot keep a transaction open across an await, and agent/network waits never belong inside
 * one (tech-stack.md §6, design-patterns.md §6). The type rejects promise-like return values.
 * At runtime, native async functions are refused before invocation. Other returned promise-likes
 * roll back synchronous writes; this cannot cancel an already scheduled continuation, which
 * must never use the connection after the callback returns.
 */
export function runInTransaction<T>(
  db: StateDatabase,
  work: () => Extract<T, PromiseLike<unknown>> extends never ? T : never,
): T {
  if (isAsyncFunction(work)) {
    throw new TypeError("transaction work must be synchronous; do not await inside it");
  }
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
