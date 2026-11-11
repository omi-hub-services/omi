import { isOutboxState } from "../../../domain/delivery/outbox-operation.js";
import type {
  OutboxRecord,
  OutboxStore,
  OutboxTransition,
  OutboxTransitionResult,
} from "../../../application/ports/outbox-store.js";
import { assertIsoUtc } from "./sqlite-lease-store.js";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

interface OutboxRow {
  operation_key: string;
  kind: string;
  subject: string;
  payload_ref: string;
  payload_hash: string;
  state: string;
  attempt_count: number;
  remote_identity: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "operation_key, kind, subject, payload_ref, payload_hash, state, attempt_count, remote_identity, next_attempt_at, last_error, created_at, updated_at";

function toRecord(row: OutboxRow): OutboxRecord {
  // The CHECK in migration 0004 makes this unreachable; a stale schema fails loudly instead.
  if (!isOutboxState(row.state)) {
    throw new RangeError(`outbox row has an unknown state: ${row.state}`);
  }
  return {
    operationKey: row.operation_key,
    kind: row.kind,
    subject: row.subject,
    payloadRef: row.payload_ref,
    payloadHash: row.payload_hash,
    state: row.state,
    attemptCount: row.attempt_count,
    remoteIdentity: row.remote_identity,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * OutboxStore over SQLite. A transition is one BEGIN IMMEDIATE transaction: the guarded UPDATE
 * and the audit event commit together, and a stale guard writes nothing. Time strings are
 * compared as text, which is correct for the fixed-width ISO-8601 UTC form `assertIsoUtc` demands.
 */
export function createSqliteOutboxStore(db: StateDatabase): OutboxStore {
  const selectLease = db.prepare(
    "SELECT owner, generation, expires_at FROM leases WHERE resource_key = ?",
  );
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM outbox WHERE operation_key = ?`);
  const selectUnresolved = db.prepare(
    `SELECT ${COLUMNS} FROM outbox WHERE state IN ('in_flight', 'outcome_unknown') ORDER BY id`,
  );
  const selectDue = db.prepare(
    `SELECT ${COLUMNS} FROM outbox
     WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY id LIMIT ?`,
  );
  const update = db.prepare(
    `UPDATE outbox
     SET state = ?, attempt_count = ?, remote_identity = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE operation_key = ? AND state = ? AND attempt_count = ?`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (event_id, kind, subject, run_id, causation_id, correlation_id, payload, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    get(operationKey) {
      const row = selectOne.get(operationKey) as OutboxRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    listUnresolved() {
      return (selectUnresolved.all() as OutboxRow[]).map(toRecord);
    },
    listDue(now, limit) {
      assertIsoUtc(now, "now");
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError("limit must be a positive integer");
      }
      return (selectDue.all(now, limit) as OutboxRow[]).map(toRecord);
    },
    transition(change: OutboxTransition): OutboxTransitionResult {
      assertIsoUtc(change.at, "at");
      if (change.nextAttemptAt !== null) assertIsoUtc(change.nextAttemptAt, "nextAttemptAt");
      return runInTransaction(db, (): OutboxTransitionResult => {
        if (change.fence !== undefined) {
          const lease = selectLease.get(change.fence.resourceKey) as
            { owner: string; generation: number; expires_at: string } | undefined;
          if (
            lease === undefined ||
            lease.owner !== change.fence.owner ||
            lease.generation !== change.fence.generation
          )
            return { ok: false, reason: "STALE_LEASE" };
          if (lease.expires_at <= change.at) return { ok: false, reason: "LEASE_EXPIRED" };
        }
        const updated = update.run(
          change.to,
          change.attemptCount,
          change.remoteIdentity,
          change.nextAttemptAt,
          change.lastError,
          change.at,
          change.operationKey,
          change.expectedState,
          change.expectedAttemptCount,
        );
        if (updated.changes === 0) {
          const found = selectOne.get(change.operationKey) !== undefined;
          return { ok: false, reason: found ? "STALE_STATE" : "NOT_FOUND" };
        }
        const { event } = change;
        insertEvent.run(
          event.eventId,
          event.kind,
          event.subject,
          event.runId ?? null,
          event.causationId ?? null,
          event.correlationId,
          event.payload,
          change.at,
        );
        const row = selectOne.get(change.operationKey) as OutboxRow;
        return { ok: true, record: toRecord(row) };
      });
    },
  };
}
