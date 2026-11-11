import type {
  AcquireLeaseRequest,
  AcquireLeaseResult,
  Lease,
  LeaseHolderRequest,
  LeaseStore,
  ReleaseLeaseResult,
  RenewLeaseRequest,
  RenewLeaseResult,
} from "../../../application/ports/lease-store.js";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

interface LeaseRow {
  resource_key: string;
  owner: string;
  generation: number;
  acquired_at: string;
  expires_at: string;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Timestamps are compared as text in SQL, so only the fixed-width UTC form is accepted. */
export function assertIsoUtc(value: string, name: string): void {
  if (!ISO_UTC.test(value)) {
    throw new RangeError(`${name} must be ISO-8601 UTC like 2026-01-01T00:00:00.000Z`);
  }
}

function toLease(row: LeaseRow): Lease {
  return {
    resourceKey: row.resource_key,
    owner: row.owner,
    generation: row.generation,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Lease adapter over the `leases` table (one row per resource key). Every operation is one
 * short BEGIN IMMEDIATE transaction, so concurrent claimants are serialised by SQLite and
 * exactly one wins. Release sets expiry equal to acquisition, retaining the fencing generation.
 * This distinguishes explicit release from timeout for resources that forbid expired takeover.
 */
export function createSqliteLeaseStore(db: StateDatabase): LeaseStore {
  const select = db.prepare("SELECT * FROM leases WHERE resource_key = ?");
  const insert = db.prepare(
    "INSERT INTO leases (resource_key, owner, generation, acquired_at, expires_at) VALUES (?, ?, 1, ?, ?)",
  );
  const takeOver = db.prepare(
    "UPDATE leases SET owner = ?, generation = generation + 1, acquired_at = ?, expires_at = ? WHERE resource_key = ?",
  );
  const extend = db.prepare("UPDATE leases SET expires_at = ? WHERE resource_key = ?");

  const read = (resourceKey: string): LeaseRow | undefined =>
    select.get(resourceKey) as LeaseRow | undefined;

  const isCurrent = (row: LeaseRow | undefined, request: LeaseHolderRequest): row is LeaseRow =>
    row !== undefined && row.owner === request.owner && row.generation === request.generation;

  return {
    acquire(request: AcquireLeaseRequest): AcquireLeaseResult {
      assertIsoUtc(request.now, "now");
      assertIsoUtc(request.expiresAt, "expiresAt");
      if (request.expiresAt <= request.now) {
        throw new RangeError("expiresAt must be after now");
      }
      return runInTransaction(db, (): AcquireLeaseResult => {
        const row = read(request.resourceKey);
        if (row === undefined) {
          insert.run(request.resourceKey, request.owner, request.now, request.expiresAt);
        } else if (
          row.expires_at > request.now ||
          (request.reclaimExpired === false && row.expires_at !== row.acquired_at)
        ) {
          return {
            ok: false,
            reason: "HELD",
            heldBy: row.owner,
            generation: row.generation,
            expiresAt: row.expires_at,
          };
        } else {
          takeOver.run(request.owner, request.now, request.expiresAt, request.resourceKey);
        }
        const lease = read(request.resourceKey);
        if (lease === undefined) throw new Error("lease row vanished inside its transaction");
        return { ok: true, lease: toLease(lease) };
      });
    },

    renew(request: RenewLeaseRequest): RenewLeaseResult {
      assertIsoUtc(request.now, "now");
      assertIsoUtc(request.expiresAt, "expiresAt");
      return runInTransaction(db, (): RenewLeaseResult => {
        const row = read(request.resourceKey);
        if (!isCurrent(row, request)) return { ok: false, reason: "STALE_LEASE" };
        if (row.expires_at <= request.now) return { ok: false, reason: "LEASE_EXPIRED" };
        extend.run(request.expiresAt, request.resourceKey);
        return { ok: true, lease: { ...toLease(row), expiresAt: request.expiresAt } };
      });
    },

    release(request: LeaseHolderRequest): ReleaseLeaseResult {
      assertIsoUtc(request.now, "now");
      return runInTransaction(db, (): ReleaseLeaseResult => {
        const row = read(request.resourceKey);
        if (!isCurrent(row, request)) return { ok: false, reason: "STALE_LEASE" };
        extend.run(row.acquired_at, request.resourceKey);
        return { ok: true };
      });
    },
  };
}
