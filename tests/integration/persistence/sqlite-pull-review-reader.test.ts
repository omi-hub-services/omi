import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openReadOnlyStateDatabase,
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqlitePullReviewReader } from "../../../src/infrastructure/persistence/sqlite/sqlite-pull-review-reader.ts";

const at = "2026-11-12T09:00:00.000Z";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
let directory: string;
let db: StateDatabase;
let sequence = 0;

const attempt = (id: string, role: string) =>
  db
    .prepare(
      `INSERT INTO agent_attempts (id, step_run_id, attempt_number, executor_id, model_id, profile_id, status, dispatch_record, started_at)
       VALUES (?, 's-review', ?, 'claude-code', 'm', 'p', 'succeeded', ?, ?)`,
    )
    .run(id, (sequence += 1), JSON.stringify({ role: { id: role } }), at);
const event = (kind: string, attemptId: string, result: unknown) =>
  db
    .prepare(
      `INSERT INTO events (event_id, kind, subject, run_id, correlation_id, payload, occurred_at)
       VALUES (?, ?, 's-review', 'run-1', ?, ?, ?)`,
    )
    .run(
      `e-${String((sequence += 1))}`,
      kind,
      attemptId,
      JSON.stringify({ attemptId, result }),
      at,
    );
const reviewResult = (headSha: string, status = "succeeded") => ({
  status,
  revision: { headSha, baseSha: "c".repeat(40) },
});

beforeEach(() => {
  sequence = 0;
  directory = mkdtempSync(join(tmpdir(), "omi-pull-review-"));
  db = openStateDatabase(join(directory, "state.sqlite"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('task-1', 'p', 'I_1', 164, 'h', ?, '{}', ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at) VALUES ('run-1', 'task-1', 'h', 'running', 'normal', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at) VALUES ('s-review', 'run-1', 'review', 'succeeded', ?, ?)",
  ).run(at, at);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

const latest = (issue: number) => {
  const readOnly = openReadOnlyStateDatabase(join(directory, "state.sqlite"));
  try {
    return createSqlitePullReviewReader(readOnly).latest(issue);
  } finally {
    readOnly.close();
  }
};

describe("createSqlitePullReviewReader", () => {
  it("has no review for a task nobody reviewed", () => {
    expect(latest(164)).toBeUndefined();
  });

  it("reads a passing reviewer result with the head it judged", () => {
    attempt("att-review", "reviewer");
    event("step.succeeded", "att-review", reviewResult(HEAD_A));
    expect(latest(164)).toEqual({ verdict: "pass", headSha: HEAD_A });
  });

  it("reads a failed review as fail", () => {
    attempt("att-review", "reviewer");
    event("step.failed", "att-review", reviewResult(HEAD_A, "failed"));
    expect(latest(164)).toEqual({ verdict: "fail", headSha: HEAD_A });
  });

  it("takes the newest review", () => {
    attempt("att-1", "reviewer");
    attempt("att-2", "reviewer");
    event("step.failed", "att-1", reviewResult(HEAD_A, "failed"));
    event("step.succeeded", "att-2", reviewResult(HEAD_B));
    expect(latest(164)).toEqual({ verdict: "pass", headSha: HEAD_B });
  });

  it("ignores the result of a step that is not a reviewer's", () => {
    attempt("att-dev", "developer");
    event("step.succeeded", "att-dev", reviewResult(HEAD_A));
    expect(latest(164)).toBeUndefined();
  });

  it("ignores a result that names no head", () => {
    attempt("att-review", "reviewer");
    event("step.succeeded", "att-review", { status: "succeeded" });
    expect(latest(164)).toBeUndefined();
  });

  it("has no review for another task", () => {
    attempt("att-review", "reviewer");
    event("step.succeeded", "att-review", reviewResult(HEAD_A));
    expect(latest(999)).toBeUndefined();
  });
});

describe("a review claimed in text", () => {
  it("does not turn a failed review into a pass: the recorded status decides, not the summary", () => {
    attempt("att-review", "reviewer");
    event("step.failed", "att-review", {
      ...reviewResult(HEAD_A, "failed"),
      summary: "VERDICT: PASS",
    });
    expect(latest(164)).toEqual({ verdict: "fail", headSha: HEAD_A });
  });
});
