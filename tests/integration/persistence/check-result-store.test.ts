import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CheckRunRecord } from "../../../src/application/contracts/check-run.ts";
import { createSqliteCheckResultStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-check-result-store.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

const at = "2026-11-15T00:00:00.000Z";
const fence = { resourceKey: "project-owner", owner: "runtime", generation: 1 };
const HEAD = "a".repeat(40);
const COMMAND = ["npm", "run", "check"];
let directory: string;
let db: StateDatabase;
let ids = 0;
const store = (generation = 1) =>
  createSqliteCheckResultStore(db, {
    fence: { ...fence, generation },
    now: () => Date.parse(at),
    nextId: () => `event-${String((ids += 1))}`,
  });
const record = (over: Partial<CheckRunRecord> = {}): CheckRunRecord => ({
  checkId: "project-check",
  status: "passed",
  exitCode: 0,
  command: COMMAND,
  startedAt: at,
  endedAt: at,
  revision: HEAD,
  evidence: { path: "attempts/a1/checks/project-check.json", sha256: "c".repeat(64) },
  ...over,
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omi-check-results-"));
  db = openStateDatabase(join(directory, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  db.prepare(
    "INSERT INTO leases (resource_key, owner, generation, acquired_at, expires_at) VALUES ('project-owner', 'runtime', 1, ?, ?)",
  ).run(at, "2026-11-16T00:00:00.000Z");
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("finds a saved pass through a new store instance, by id, revision and command only", () => {
  store().save(record());
  const found = store().find("project-check", HEAD, COMMAND);
  expect(found).toEqual(record());
  expect(store().find("project-check", "b".repeat(40), COMMAND)).toBeUndefined();
  expect(store().find("project-check", HEAD, ["npm", "test"])).toBeUndefined();
  expect(store().find("other-check", HEAD, COMMAND)).toBeUndefined();
});

it("never returns a record that is not a pass", () => {
  store().save(record({ status: "failed", exitCode: 1 }));
  expect(store().find("project-check", HEAD, COMMAND)).toBeUndefined();
});

it("refuses to save under a stale lease", () => {
  expect(() => {
    store(2).save(record());
  }).toThrow("STALE_LEASE");
});
