import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteAttemptStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-attempt-store.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { dispatchStep } from "../../../src/application/use-cases/runs/dispatch-step.ts";
import { dispatchInput, rig } from "../../unit/application/use-cases/runs/run-fakes.ts";
import type { AttemptRecord } from "../../../src/application/ports/attempt-store.ts";

const at = "2026-11-11T00:00:00.000Z";
const fence = { resourceKey: "project-owner", owner: "runtime", generation: 1 };
let directory: string;
let db: StateDatabase;
let record: AttemptRecord;
const store = () => createSqliteAttemptStore(db, { fence, now: () => Date.parse(at) });
const reserve = (id: string, number: number) =>
  db
    .prepare(
      `INSERT INTO agent_attempts
  (id, step_run_id, attempt_number, executor_id, model_id, profile_id, chosen_effort, selection_reason, status, started_at)
  VALUES (?, 'step-1', ?, 'claude-code', 'opus', 'profile-a', ?, ?, 'pending', ?)`,
    )
    .run(id, number, record.selection?.effort ?? null, record.selection?.reason ?? null, at);

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "omi-attempt-store-"));
  db = openStateDatabase(join(directory, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('task', 'p', 'I_1', 1, 'h', ?, '{}', ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at) VALUES ('run-1', 'task', 'h', 'running', 'normal', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at) VALUES ('step-1', 'run-1', 'implement', 'ready', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO leases (resource_key, owner, generation, acquired_at, expires_at) VALUES ('project-owner', 'runtime', 1, ?, ?)",
  ).run(at, "2026-11-12T00:00:00.000Z");
  const r = rig();
  const dispatched = await dispatchStep(r.deps, dispatchInput());
  if (!dispatched.ok) throw new Error(dispatched.reason);
  record = { ...dispatched.attempt, status: "pending" };
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("SQLite attempt dispatch records", () => {
  it("reuses the reserved number after cancelled reservations instead of colliding with them", async () => {
    reserve("cancelled-1", 1);
    store().setStatus("cancelled-1", "cancelled");
    reserve("reserved-3", 3);
    const r = rig();
    const result = await dispatchStep(
      { ...r.deps, attempts: store() },
      dispatchInput({ reservedAttemptId: "reserved-3" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.attempt.attemptNumber).toBe(3);
    expect(store().latestForStep("step-1")?.id).toBe("reserved-3");
  });
  it("persists a reservation across reopen, completes it once without replacing selection/process identity, then reopens a terminal record", () => {
    reserve(record.id, 1);
    db.close();
    db = openStateDatabase(join(directory, "state.db"));
    expect(store().get(record.id)).toBeUndefined();
    expect(store().reservedNumber?.(record.id)).toBe(1);
    db.prepare(
      "UPDATE agent_attempts SET process_pid=123, process_started_at='identity', process_generation=7 WHERE id=?",
    ).run(record.id);
    store().create(record);
    expect(() => {
      store().create(record);
    }).toThrow("ATTEMPT_RESERVATION_MISMATCH");
    store().setStatus(record.id, "running");
    store().setStatus(record.id, "succeeded");
    db.close();
    db = openStateDatabase(join(directory, "state.db"));
    expect(store().get(record.id)).toEqual({ ...record, status: "succeeded" });
    expect(store().latestForStep("step-1")).toEqual({ ...record, status: "succeeded" });
    expect(
      db
        .prepare(
          "SELECT profile_id, process_pid, process_generation FROM agent_attempts WHERE id=?",
        )
        .get(record.id),
    ).toEqual({ profile_id: "profile-a", process_pid: 123, process_generation: 7 });
  });
  it("cancels an incomplete reservation durably and releases its capacity slot", () => {
    reserve(record.id, 1);
    store().setStatus(record.id, "cancelled");
    db.close();
    db = openStateDatabase(join(directory, "state.db"));
    expect(db.prepare("SELECT status FROM agent_attempts WHERE id=?").get(record.id)).toEqual({
      status: "cancelled",
    });
    expect(
      db
        .prepare(
          "SELECT count(*) AS active FROM agent_attempts WHERE status IN ('pending', 'running')",
        )
        .get(),
    ).toEqual({ active: 0 });
    expect(() => {
      store().create(record);
    }).toThrow("ATTEMPT_RESERVATION_MISMATCH");
  });
  it("rolls back completion when dispatch disagrees with selection", () => {
    reserve(record.id, 1);
    expect(() => {
      store().create({ ...record, executor: "codex" });
    }).toThrow("ATTEMPT_RESERVATION_MISMATCH");
    expect(store().get(record.id)).toBeUndefined();
    expect(store().reservedNumber?.(record.id)).toBe(1);
    store().create(record);
    expect(store().get(record.id)).toEqual(record);
  });
  it("refuses unreserved dispatches, missing attempts, invalid metadata and stale owners", () => {
    expect(() => {
      store().create(record);
    }).toThrow("ATTEMPT_NOT_RESERVED");
    expect(() => {
      store().setStatus("missing", "cancelled");
    }).toThrow("ATTEMPT_NOT_FOUND");
    reserve(record.id, 1);
    expect(() => {
      store().create({ ...record, contextPacket: { path: "../escape", sha256: "a".repeat(64) } });
    }).toThrow();
    db.prepare("UPDATE leases SET generation=2 WHERE resource_key='project-owner'").run();
    expect(() => {
      store().create(record);
    }).toThrow("STALE_LEASE");
    expect(() => {
      store().setStatus(record.id, "cancelled");
    }).toThrow("STALE_LEASE");
    expect(store().reservedNumber?.(record.id)).toBe(1);
  });
});

it("counts quality failures separately from failovers and supplies the previous verdict", () => {
  expect(store().qualityHistory?.("step-1")).toEqual({ round: 1 });
  const verdict = {
    schemaVersion: 1,
    runId: "run-1",
    stepId: "review",
    attemptId: "old",
    status: "failed",
    summary: "fix edge case",
    artifacts: [],
    checks: [],
    skillsApplied: [],
    findings: [],
    revision: { headSha: "a".repeat(40), baseSha: "b".repeat(40) },
  };
  const insert = db.prepare(
    "INSERT INTO events (event_id, kind, subject, run_id, correlation_id, payload, occurred_at) VALUES (?, ?, 'step-1', 'run-1', 'old', ?, ?)",
  );
  insert.run("limit", "step.waiting_resource", JSON.stringify({ reason: "USAGE_LIMIT" }), at);
  expect(store().qualityHistory?.("step-1")).toEqual({ round: 1 });
  insert.run(
    "quality",
    "step.failed",
    JSON.stringify({ outcome: "succeeded", result: verdict }),
    at,
  );
  expect(store().qualityHistory?.("step-1")).toEqual({ round: 2, previousVerdict: verdict });
});

it("excludes actual executor start-failure payloads from quality history", async () => {
  const r = rig();
  r.executor.failStart = true;
  expect(await dispatchStep(r.deps, dispatchInput())).toMatchObject({
    reason: "EXECUTOR_START_FAILED",
  });
  const failure = r.unitOfWork.commits.find((change) => change.event.kind === "step.failed");
  if (failure === undefined) throw new Error("missing start-failure event");
  expect(JSON.parse(failure.event.payload)).toEqual({ attemptId: "id-1", reason: "SPAWN_FAILED" });
  db.prepare(
    "INSERT INTO events (event_id, kind, subject, run_id, correlation_id, payload, occurred_at) VALUES ('start-failed', 'step.failed', 'step-1', 'run-1', 'id-1', ?, ?)",
  ).run(failure.event.payload, at);
  expect(store().qualityHistory?.("step-1")).toEqual({ round: 1 });
});

it("reads preceding QA attempts by run and step without falling back past a reservation", () => {
  reserve(record.id, 1);
  store().create(record);
  store().setStatus(record.id, "succeeded");
  expect(store().latestForRunStep?.("run-1", "implement")).toMatchObject({
    id: record.id,
    status: "succeeded",
  });
  expect(store().latestForRunStep?.("other-run", "implement")).toBeUndefined();
  reserve("pending-retry", 2);
  expect(store().latestForRunStep?.("run-1", "implement")).toBeUndefined();
  store().create({ ...record, id: "pending-retry", attemptNumber: 2 });
  store().setStatus("pending-retry", "succeeded");
  expect(store().latestForRunStep?.("run-1", "implement")).toMatchObject({ id: "pending-retry" });
  db.prepare(
    "INSERT INTO step_runs (id, run_id, step_key, iteration, status, created_at, updated_at) VALUES ('qa-iteration-2', 'run-1', 'implement', 2, 'ready', ?, ?)",
  ).run(at, at);
  expect(store().latestForRunStep?.("run-1", "implement")).toBeUndefined();
});

it("persists an operational budget separate from quality across a restart", () => {
  const insert = db.prepare(
    "INSERT INTO events (event_id, kind, subject, run_id, correlation_id, payload, occurred_at) VALUES (?, ?, 'step-1', 'run-1', 'a', ?, ?)",
  );
  insert.run("quality-fail", "step.failed", JSON.stringify({ outcome: "succeeded" }), at);
  insert.run("infra-fail", "step.failed", JSON.stringify({ outcome: "failed" }), at);
  insert.run(
    "start-fail",
    "step.failed",
    JSON.stringify({ attemptId: "a", reason: "SPAWN_FAILED" }),
    at,
  );
  insert.run("limit-fail", "step.waiting_resource", JSON.stringify({ reason: "USAGE_LIMIT" }), at);
  db.close();
  db = openStateDatabase(join(directory, "state.db"));
  expect(store().operationalFailuresForStep("step-1")).toBe(3);
});
