import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteWorkerReportReader } from "../../../src/infrastructure/persistence/sqlite/sqlite-worker-report-reader.ts";

it("reads only the selected attempt's newest recorded completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-worker-report-"));
  const db = openStateDatabase(join(dir, "state.sqlite"));
  try {
    applyMigrations(db, loadMigrations(resolve("migrations")));
    const insert = db.prepare(
      "INSERT INTO events(event_id, kind, subject, correlation_id, payload, occurred_at) VALUES (?, ?, 'step', ?, ?, '2026-11-12T00:00:00.000Z')",
    );
    insert.run("e1", "step.failed", "a", JSON.stringify({ outcome: "failed", exitCode: 1 }));
    insert.run("e2", "step.succeeded", "b", JSON.stringify({ outcome: "succeeded", exitCode: 0 }));
    insert.run("e3", "step.running", "a", "{}");
    const reader = createSqliteWorkerReportReader(db);
    expect(reader.read("a")).toEqual({ outcome: "failed", exitCode: 1 });
    expect(reader.read("b")).toEqual({ outcome: "succeeded", exitCode: 0 });
    expect(reader.read("unknown")).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
