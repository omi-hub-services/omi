import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StateChange } from "../../../src/application/ports/state-unit-of-work.ts";
import { worktreeLeaseKey } from "../../../src/domain/runs/lease-resource.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";

const MIGRATIONS = resolve(import.meta.dirname, "../../../migrations");
const T0 = "2026-11-10T00:00:00.000Z";
const T1 = "2026-11-10T00:01:00.000Z";
const T2 = "2026-11-10T00:02:00.000Z";
const T3 = "2026-11-10T00:03:00.000Z";
const KEY = worktreeLeaseKey("wt-1");

let dir: string;
let db: StateDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-uow-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, loadMigrations(MIGRATIONS));
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p1', 'acme/app', 'h', ?, ?)",
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at)
     VALUES ('t1', 'p1', 'I_1', 1, 'h', ?, '{}', ?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at)
     VALUES ('r1', 't1', 'h', 'running', 'implementation', ?, ?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at)
     VALUES ('s1', 'r1', 'implement', 'running', ?, ?)`,
  ).run(T0, T0);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const OUTBOX = {
  operationKey: "op-1",
  kind: "github.comment",
  subject: "step_run:s1",
  payloadRef: "artifacts/comment.md",
  payloadHash: "abc",
};

function change(overrides: Partial<StateChange> = {}): StateChange {
  return {
    target: { kind: "step_run", id: "s1", expectedVersion: 0, toStatus: "succeeded" },
    at: T1,
    event: {
      eventId: "e1",
      kind: "step.succeeded",
      subject: "step_run:s1",
      runId: "r1",
      correlationId: "c1",
      payload: "{}",
    },
    outbox: OUTBOX,
    ...overrides,
  };
}

function counts(): { events: number; outbox: number; stepVersion: number; stepStatus: string } {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const step = db.prepare("SELECT status, version FROM step_runs WHERE id = 's1'").get() as {
    status: string;
    version: number;
  };
  return {
    events: one("SELECT count(*) AS n FROM events"),
    outbox: one("SELECT count(*) AS n FROM outbox"),
    stepVersion: step.version,
    stepStatus: step.status,
  };
}

describe("state + event + outbox unit of work", () => {
  it("commits state, event and outbox together and bumps the version", () => {
    const uow = createSqliteStateUnitOfWork(db);
    const result = uow.commit(change());

    expect(result).toEqual({ ok: true, newVersion: 1, eventSequence: 1 });
    expect(counts()).toEqual({
      events: 1,
      outbox: 1,
      stepVersion: 1,
      stepStatus: "succeeded",
    });
    expect(db.prepare("SELECT state, occurred_at FROM events, outbox LIMIT 1").get()).toEqual({
      state: "pending",
      occurred_at: T1,
    });
  });

  it("works without an outbox row and for a workflow run", () => {
    const uow = createSqliteStateUnitOfWork(db);
    const { at, event } = change();
    const result = uow.commit({
      target: { kind: "workflow_run", id: "r1", expectedVersion: 0, toStatus: "paused" },
      at,
      event,
    });
    expect(result).toMatchObject({ ok: true, newVersion: 1 });
    expect(db.prepare("SELECT status, version FROM workflow_runs").get()).toEqual({
      status: "paused",
      version: 1,
    });
    expect(counts().outbox).toBe(0);
  });

  it("rolls back state and event when the outbox insert fails", () => {
    const uow = createSqliteStateUnitOfWork(db);
    expect(uow.commit(change())).toMatchObject({ ok: true });
    // Same operation key again: the unique constraint fails after state and event were written.
    expect(() =>
      uow.commit(
        change({
          target: { kind: "step_run", id: "s1", expectedVersion: 1, toStatus: "failed" },
          event: { ...change().event, eventId: "e2" },
        }),
      ),
    ).toThrow(/operation_key/);
    expect(counts()).toEqual({ events: 1, outbox: 1, stepVersion: 1, stepStatus: "succeeded" });
  });

  it("rolls back state and outbox when the event insert fails", () => {
    const uow = createSqliteStateUnitOfWork(db);
    expect(() =>
      uow.commit(change({ event: { ...change().event, runId: "missing-run" } })),
    ).toThrow(/FOREIGN KEY/);
    expect(counts()).toEqual({ events: 0, outbox: 0, stepVersion: 0, stepStatus: "running" });
  });

  it("rejects a stale version without writing anything (late event)", () => {
    const uow = createSqliteStateUnitOfWork(db);
    expect(uow.commit(change())).toMatchObject({ ok: true });

    const late = uow.commit(
      change({
        target: { kind: "step_run", id: "s1", expectedVersion: 0, toStatus: "failed" },
        event: { ...change().event, eventId: "e-late" },
        outbox: { ...OUTBOX, operationKey: "op-late" },
      }),
    );
    expect(late).toEqual({ ok: false, reason: "STALE_VERSION" });
    expect(counts()).toEqual({ events: 1, outbox: 1, stepVersion: 1, stepStatus: "succeeded" });
  });

  it("reports a missing row instead of a version conflict", () => {
    const uow = createSqliteStateUnitOfWork(db);
    const result = uow.commit(
      change({ target: { kind: "step_run", id: "nope", expectedVersion: 0, toStatus: "failed" } }),
    );
    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(counts().events).toBe(0);
  });

  it("lets only one of two writers with the same expected version win", () => {
    const uow = createSqliteStateUnitOfWork(db);
    const first = uow.commit(change());
    const second = uow.commit(
      change({
        target: { kind: "step_run", id: "s1", expectedVersion: 0, toStatus: "cancelled" },
        event: { ...change().event, eventId: "e2" },
        outbox: { ...OUTBOX, operationKey: "op-2" },
      }),
    );
    expect([first.ok, second.ok]).toEqual([true, false]);
    expect(counts().stepStatus).toBe("succeeded");
  });
});

describe("lease fencing on commit", () => {
  const fence = (owner: string, generation: number) => ({
    resourceKey: KEY,
    owner,
    generation,
  });

  it("applies a completion that carries the current lease generation", () => {
    const leases = createSqliteLeaseStore(db);
    leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T3 });
    const result = createSqliteStateUnitOfWork(db).commit(change({ fence: fence("A", 1) }));
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a late completion from an older generation after re-acquire", () => {
    const leases = createSqliteLeaseStore(db);
    leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T1 });
    // A stalls; its lease expires and B takes over with generation 2.
    expect(leases.acquire({ resourceKey: KEY, owner: "B", now: T2, expiresAt: T3 })).toMatchObject({
      ok: true,
      lease: { generation: 2 },
    });

    const late = createSqliteStateUnitOfWork(db).commit(change({ at: T2, fence: fence("A", 1) }));
    expect(late).toEqual({ ok: false, reason: "STALE_LEASE" });
    expect(counts()).toEqual({ events: 0, outbox: 0, stepVersion: 0, stepStatus: "running" });
  });

  it("rejects the same owner with an older generation after it re-acquired", () => {
    const leases = createSqliteLeaseStore(db);
    leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T1 });
    leases.acquire({ resourceKey: KEY, owner: "A", now: T1, expiresAt: T3 });
    const late = createSqliteStateUnitOfWork(db).commit(change({ at: T2, fence: fence("A", 1) }));
    expect(late).toEqual({ ok: false, reason: "STALE_LEASE" });
  });

  it("rejects a write whose own lease has expired and was not re-acquired", () => {
    createSqliteLeaseStore(db).acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T1 });
    const late = createSqliteStateUnitOfWork(db).commit(change({ at: T2, fence: fence("A", 1) }));
    expect(late).toEqual({ ok: false, reason: "LEASE_EXPIRED" });
    expect(counts().events).toBe(0);
  });

  it("rejects a write when nobody ever held the lease", () => {
    const result = createSqliteStateUnitOfWork(db).commit(change({ fence: fence("A", 1) }));
    expect(result).toEqual({ ok: false, reason: "STALE_LEASE" });
  });
});
