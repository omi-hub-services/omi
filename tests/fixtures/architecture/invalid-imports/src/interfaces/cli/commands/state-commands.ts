// VIOLATION interfaces-not-to-infrastructure (persistence) + interfaces-no-sql-github-spawn
import Database from "better-sqlite3";
import { readRunStatus } from "../../../infrastructure/persistence/sqlite/sqlite-state-store.js";

export const statusCommand = (runId: string) => [new Database(":memory:"), readRunStatus(runId)];
