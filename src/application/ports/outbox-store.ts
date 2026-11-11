import type { OutboxState } from "../../domain/delivery/outbox-operation.js";
import type { AuditEvent, LeaseFence } from "./state-unit-of-work.js";

/** One outbox row. Timestamps are ISO-8601 UTC text supplied by the runtime. */
export interface OutboxRecord {
  readonly operationKey: string;
  readonly kind: string;
  readonly subject: string;
  /** Artifact path of the payload; `payloadHash` is its pinned sha-256. */
  readonly payloadRef: string;
  readonly payloadHash: string;
  readonly state: OutboxState;
  readonly attemptCount: number;
  readonly remoteIdentity: string | null;
  /** The operation must not be sent before this time; null means no wait. */
  readonly nextAttemptAt: string | null;
  /** Short code of the last refusal or failure; never remote text. */
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The values a transition writes. The target state comes from the domain machine. */
export interface OutboxTransition {
  readonly fence?: LeaseFence;
  readonly operationKey: string;
  /** Compare-and-swap guard: the row must still be in this state with this attempt count. */
  readonly expectedState: OutboxState;
  readonly expectedAttemptCount: number;
  readonly to: OutboxState;
  readonly attemptCount: number;
  readonly remoteIdentity: string | null;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly at: string;
  /** Appended in the same transaction as the state change. */
  readonly event: AuditEvent;
}

export type OutboxRejection = "NOT_FOUND" | "STALE_STATE" | "STALE_LEASE" | "LEASE_EXPIRED";

export type OutboxTransitionResult =
  | { readonly ok: true; readonly record: OutboxRecord }
  | { readonly ok: false; readonly reason: OutboxRejection };

/**
 * Reads and moves outbox rows. Entries are inserted together with the state change that caused
 * them (`StateUnitOfWork`); this port only works the queue. Calls are synchronous and short:
 * remote I/O never happens inside one.
 */
export interface OutboxStore {
  get(operationKey: string): OutboxRecord | undefined;
  /** Operations whose remote outcome is not settled: `in_flight` and `outcome_unknown`, oldest first. */
  listUnresolved(): readonly OutboxRecord[];
  /** `pending` operations whose `nextAttemptAt` is empty or not after `now`, oldest first. */
  listDue(now: string, limit: number): readonly OutboxRecord[];
  /** Moves one row and appends its audit event atomically; a stale guard writes nothing. */
  transition(change: OutboxTransition): OutboxTransitionResult;
}
