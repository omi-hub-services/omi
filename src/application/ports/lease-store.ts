export const PROJECT_OWNER_LEASE_KEY = "project-owner";

import type { StateChange, StateUnitOfWork } from "./state-unit-of-work.js";

/**
 * Leases with a fencing token (architecture.md §8): one holder per resource key, and every new
 * acquisition of a key gets a higher `generation`. A write or completion that carries an older
 * generation is stale and must be rejected by whoever applies it (see StateUnitOfWork).
 *
 * Timestamps are ISO-8601 UTC strings supplied by the caller (`YYYY-MM-DDTHH:mm:ss.sssZ`); the
 * store never reads the clock. A lease is held while `expiresAt` is after `now`.
 * A released row has `expiresAt === acquiredAt`. Acquisitions with `reclaimExpired: false`
 * retain their reservation after timeout until explicit release confirms the writer stopped.
 */
export interface Lease {
  readonly resourceKey: string;
  readonly owner: string;
  readonly generation: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface AcquireLeaseRequest {
  readonly resourceKey: string;
  readonly owner: string;
  readonly now: string;
  readonly expiresAt: string;
  /** Writers require explicit release after their process stops, even after expiry. */
  readonly reclaimExpired?: boolean;
}

export interface LeaseHolderRequest {
  readonly resourceKey: string;
  readonly owner: string;
  readonly generation: number;
  readonly now: string;
}

export interface RenewLeaseRequest extends LeaseHolderRequest {
  readonly expiresAt: string;
}

export type AcquireLeaseResult =
  | { readonly ok: true; readonly lease: Lease }
  | {
      readonly ok: false;
      readonly reason: "HELD";
      readonly heldBy: string;
      readonly generation: number;
      readonly expiresAt: string;
    };

export type RenewLeaseResult =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly reason: "STALE_LEASE" | "LEASE_EXPIRED" };

export type ReleaseLeaseResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "STALE_LEASE" };

export interface LeaseStore {
  /** Takes a free/released resource; expired takeover defaults to true for existing callers. */
  acquire(request: AcquireLeaseRequest): AcquireLeaseResult;
  /** Extends the lease of the current holder and generation; stale or expired is refused. */
  renew(request: RenewLeaseRequest): RenewLeaseResult;
  /** Marks explicit release with expiry equal to acquisition; retains owner and generation. */
  release(request: LeaseHolderRequest): ReleaseLeaseResult;
}

export interface ProjectSession {
  readonly lease: Lease;
  renew(): boolean;
  record(kind: string, payload: Readonly<Record<string, unknown>>): void;
  release(): void;
  commit(change: Omit<StateChange, "fence" | "at">): ReturnType<StateUnitOfWork["commit"]>;
}
