/**
 * Leases with a fencing token (architecture.md §8): one holder per resource key, and every new
 * acquisition of a key gets a higher `generation`. A write or completion that carries an older
 * generation is stale and must be rejected by whoever applies it (see StateUnitOfWork).
 *
 * Timestamps are ISO-8601 UTC strings supplied by the caller (`YYYY-MM-DDTHH:mm:ss.sssZ`); the
 * store never reads the clock. A lease is held while `expiresAt` is after `now`.
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
  /** Takes a free or expired resource (generation + 1); refuses while another holder has it. */
  acquire(request: AcquireLeaseRequest): AcquireLeaseResult;
  /** Extends the lease of the current holder and generation; stale or expired is refused. */
  renew(request: RenewLeaseRequest): RenewLeaseResult;
  /** Ends the current holder's lease. The generation is kept so it is never reused. */
  release(request: LeaseHolderRequest): ReleaseLeaseResult;
}
