import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutboxTransition } from "../../../src/application/ports/outbox-store.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";

const T0 = "2026-11-11T08:00:00.000Z";
const T1 = "2026-11-11T08:05:00.000Z";
const T2 = "2026-11-11T08:10:00.000Z";

let dir: string;
let db: StateDatabase;

const seed = (key: string, state = "pending", nextAttemptAt: string | null = null) =>
  db
    .prepare(
      `INSERT INTO outbox (operation_key, kind, subject, payload_ref, payload_hash, state, next_attempt_at, created_at, updated_at)
       VALUES (?, 'issue.comment', 'run-1', 'payloads/p.json', ?, ?, ?, ?, ?)`,
    )
    .run(key, "a".repeat(64), state, nextAttemptAt, T0, T0);

function change(overrides: Partial<OutboxTransition> = {}): OutboxTransition {
  return {
    operationKey: "op-1",
    expectedState: "pending",
    expectedAttemptCount: 0,
    to: "in_flight",
    attemptCount: 1,
    remoteIdentity: null,
    nextAttemptAt: null,
    lastError: null,
    at: T1,
    event: {
      eventId: "event-1",
      kind: "outbox.in_flight",
      subject: "run-1",
      correlationId: "op-1",
      payload: "{}",
    },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-outbox-store-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite outbox store", () => {
  it("lists only due pending operations, oldest first, and honours the limit", () => {
    seed("due-1");
    seed("waiting", "pending", T2);
    seed("due-2", "pending", T1);
    seed("flight", "in_flight");
    seed("failed", "failed");
    const store = createSqliteOutboxStore(db);
    expect(store.listDue(T1, 10).map((r) => r.operationKey)).toEqual(["due-1", "due-2"]);
    expect(store.listDue(T0, 10).map((r) => r.operationKey)).toEqual(["due-1"]);
    expect(store.listDue(T2, 10).map((r) => r.operationKey)).toEqual(["due-1", "waiting", "due-2"]);
    expect(store.listDue(T2, 2).map((r) => r.operationKey)).toEqual(["due-1", "waiting"]);
    expect(() => store.listDue(T2, 0)).toThrow(RangeError);
    expect(() => store.listDue("tomorrow", 1)).toThrow(RangeError);
  });

  it("lists in-flight and unknown-outcome operations as unresolved", () => {
    seed("a", "pending");
    seed("b", "in_flight");
    seed("c", "outcome_unknown");
    seed("d", "failed");
    expect(
      createSqliteOutboxStore(db)
        .listUnresolved()
        .map((r) => [r.operationKey, r.state]),
    ).toEqual([
      ["b", "in_flight"],
      ["c", "outcome_unknown"],
    ]);
  });

  it("moves a row and appends its audit event in one commit", () => {
    seed("op-1");
    const store = createSqliteOutboxStore(db);
    const result = store.transition(change());
    expect(result).toMatchObject({
      ok: true,
      record: { operationKey: "op-1", state: "in_flight", attemptCount: 1, updatedAt: T1 },
    });
    expect(store.get("op-1")).toMatchObject({ state: "in_flight", attemptCount: 1 });
    expect(db.prepare("SELECT event_id, kind, occurred_at FROM events").all()).toEqual([
      { event_id: "event-1", kind: "outbox.in_flight", occurred_at: T1 },
    ]);
  });

  it("stores the remote identity, next attempt time and error code", () => {
    seed("op-1", "in_flight");
    const store = createSqliteOutboxStore(db);
    store.transition(
      change({
        expectedState: "in_flight",
        expectedAttemptCount: 0,
        to: "pending",
        attemptCount: 1,
        nextAttemptAt: T2,
        lastError: "RATE_LIMITED",
      }),
    );
    expect(store.get("op-1")).toMatchObject({
      state: "pending",
      nextAttemptAt: T2,
      lastError: "RATE_LIMITED",
      remoteIdentity: null,
    });
  });

  it("refuses a stale state or attempt count and writes nothing", () => {
    seed("op-1");
    const store = createSqliteOutboxStore(db);
    expect(store.transition(change({ expectedState: "in_flight" }))).toEqual({
      ok: false,
      reason: "STALE_STATE",
    });
    expect(store.transition(change({ expectedAttemptCount: 5 }))).toEqual({
      ok: false,
      reason: "STALE_STATE",
    });
    expect(store.transition(change({ operationKey: "missing" }))).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(store.get("op-1")).toMatchObject({ state: "pending", attemptCount: 0, updatedAt: T0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });

  it("lets only one of two writers with the same expectation win", () => {
    seed("op-1");
    const store = createSqliteOutboxStore(db);
    const first = store.transition(change());
    const second = store.transition(change({ event: { ...change().event, eventId: "event-2" } }));
    expect([first.ok, second.ok]).toEqual([true, false]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("rolls the state change back when the audit event cannot be written", () => {
    seed("op-1");
    const store = createSqliteOutboxStore(db);
    store.transition(change());
    // The same event id again violates the unique event_id: nothing of the second change stays.
    expect(() =>
      store.transition(
        change({ expectedState: "in_flight", expectedAttemptCount: 1, to: "outcome_unknown" }),
      ),
    ).toThrow(/UNIQUE constraint failed/);
    expect(store.get("op-1")).toMatchObject({ state: "in_flight" });
  });

  it("rejects a transition into a state the database does not allow", () => {
    seed("op-1");
    const store = createSqliteOutboxStore(db);
    expect(() => store.transition(change({ to: "done" as never }))).toThrow(
      /CHECK constraint failed/,
    );
    expect(store.get("op-1")).toMatchObject({ state: "pending" });
  });

  it("returns undefined for a missing operation", () => {
    expect(createSqliteOutboxStore(db).get("nope")).toBeUndefined();
  });
});
