import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const MIGRATIONS = resolve(import.meta.dirname, "../../../migrations");
const T0 = "2026-11-10T00:00:00.000Z";
const T1 = "2026-11-10T00:01:00.000Z";
const T2 = "2026-11-10T00:02:00.000Z";
const T3 = "2026-11-10T00:03:00.000Z";
const KEY = worktreeLeaseKey("wt-1");

let dir: string;
let db: StateDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-lease-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, loadMigrations(MIGRATIONS));
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("worktree lease", () => {
  it("scopes the resource key per worktree and rejects an empty id", () => {
    expect(worktreeLeaseKey("wt-1")).not.toBe(worktreeLeaseKey("wt-2"));
    expect(() => worktreeLeaseKey(" ")).toThrow(RangeError);
  });

  it("admits exactly one holder when two claimants compete", () => {
    const leases = createSqliteLeaseStore(db);
    const a = leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T2 });
    const b = leases.acquire({ resourceKey: KEY, owner: "B", now: T0, expiresAt: T2 });

    expect(a).toMatchObject({ ok: true, lease: { owner: "A", generation: 1 } });
    expect(b).toEqual({ ok: false, reason: "HELD", heldBy: "A", generation: 1, expiresAt: T2 });
    expect(db.prepare("SELECT owner FROM leases").all()).toEqual([{ owner: "A" }]);
  });

  it("lets the same owner not double-acquire; renewing is the way to extend", () => {
    const leases = createSqliteLeaseStore(db);
    leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T1 });
    expect(leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T2 })).toMatchObject({
      ok: false,
      reason: "HELD",
    });
  });

  it("bumps the generation when an expired lease is re-acquired", () => {
    const leases = createSqliteLeaseStore(db);
    leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T1 });
    const b = leases.acquire({ resourceKey: KEY, owner: "B", now: T1, expiresAt: T3 });
    expect(b).toMatchObject({ ok: true, lease: { owner: "B", generation: 2 } });
  });

  it("renews with the current generation and rejects a stale one", () => {
    const leases = createSqliteLeaseStore(db);
    leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T1 });
    leases.acquire({ resourceKey: KEY, owner: "B", now: T1, expiresAt: T2 });

    expect(
      leases.renew({ resourceKey: KEY, owner: "A", generation: 1, now: T1, expiresAt: T3 }),
    ).toEqual({ ok: false, reason: "STALE_LEASE" });
    const renewed = leases.renew({
      resourceKey: KEY,
      owner: "B",
      generation: 2,
      now: T1,
      expiresAt: T3,
    });
    expect(renewed).toMatchObject({ ok: true, lease: { generation: 2, expiresAt: T3 } });
  });

  it("does not renew a lease that already expired", () => {
    const leases = createSqliteLeaseStore(db);
    leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T1 });
    expect(
      leases.renew({ resourceKey: KEY, owner: "A", generation: 1, now: T2, expiresAt: T3 }),
    ).toEqual({ ok: false, reason: "LEASE_EXPIRED" });
  });

  it("releases so another claimant can take over, and never reuses a generation", () => {
    const leases = createSqliteLeaseStore(db);
    leases.acquire({ resourceKey: KEY, owner: "A", now: T0, expiresAt: T3 });

    expect(leases.release({ resourceKey: KEY, owner: "B", generation: 1, now: T1 })).toEqual({
      ok: false,
      reason: "STALE_LEASE",
    });
    expect(leases.release({ resourceKey: KEY, owner: "A", generation: 1, now: T1 })).toEqual({
      ok: true,
    });
    const b = leases.acquire({ resourceKey: KEY, owner: "B", now: T1, expiresAt: T3 });
    expect(b).toMatchObject({ ok: true, lease: { generation: 2 } });
    expect(leases.release({ resourceKey: KEY, owner: "A", generation: 1, now: T2 })).toEqual({
      ok: false,
      reason: "STALE_LEASE",
    });
  });

  it("keeps different worktrees independent", () => {
    const leases = createSqliteLeaseStore(db);
    expect(
      leases.acquire({ resourceKey: worktreeLeaseKey("wt-1"), owner: "A", now: T0, expiresAt: T2 }),
    ).toMatchObject({ ok: true });
    expect(
      leases.acquire({ resourceKey: worktreeLeaseKey("wt-2"), owner: "B", now: T0, expiresAt: T2 }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a timestamp that is not ISO-8601 UTC, which would compare wrongly as text", () => {
    const leases = createSqliteLeaseStore(db);
    expect(() =>
      leases.acquire({ resourceKey: KEY, owner: "A", now: "yesterday", expiresAt: T1 }),
    ).toThrow(RangeError);
  });
});
