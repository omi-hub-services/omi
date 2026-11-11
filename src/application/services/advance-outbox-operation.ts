import type { ArtifactStore } from "../ports/artifact-store.js";
import type { OutboxRecord, OutboxStore } from "../ports/outbox-store.js";
import type { GithubOperation } from "../contracts/github-operation.js";
import { parseGithubOperationPayload } from "../contracts/github-operation.js";
import { transitionOutbox } from "../../domain/delivery/outbox-operation.js";
import type { OutboxEvent, OutboxRefusal } from "../../domain/delivery/outbox-operation.js";

/** What the outbox use cases need from the runtime. Time and ids are values, never read here. */
export interface OutboxRuntime {
  readonly outbox: OutboxStore;
  /** Epoch ms. */
  readonly now: () => number;
  readonly newEventId: () => string;
}

export interface OutboxPatch {
  readonly attemptCount?: number;
  readonly remoteIdentity?: string;
  /** Epoch ms; omitted clears the wait. */
  readonly notBeforeMs?: number;
  /** Short code, never remote text; omitted keeps the previous code, `null` clears it. */
  readonly lastError?: string | null;
}

export type AdvanceResult =
  | { readonly ok: true; readonly record: OutboxRecord }
  | { readonly ok: false; readonly reason: OutboxRefusal | "TRANSITION_NOT_ALLOWED" | "STALE" };

/**
 * The one place that moves an outbox row: asks the domain machine first, then persists the new
 * state with compare-and-swap and an audit event in one transaction. A row is never written
 * with a state the machine did not allow, and a concurrent writer makes this return `STALE`.
 */
export function advanceOutboxOperation(
  runtime: OutboxRuntime,
  record: OutboxRecord,
  event: OutboxEvent,
  patch: OutboxPatch = {},
): AdvanceResult {
  const outcome = transitionOutbox(record.state, event);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };

  const attemptCount = patch.attemptCount ?? record.attemptCount;
  const lastError = patch.lastError === undefined ? record.lastError : patch.lastError;
  const at = new Date(runtime.now()).toISOString();
  const result = runtime.outbox.transition({
    operationKey: record.operationKey,
    expectedState: record.state,
    expectedAttemptCount: record.attemptCount,
    to: outcome.to,
    attemptCount,
    remoteIdentity: patch.remoteIdentity ?? record.remoteIdentity,
    nextAttemptAt:
      patch.notBeforeMs === undefined ? null : new Date(patch.notBeforeMs).toISOString(),
    lastError,
    at,
    event: {
      eventId: runtime.newEventId(),
      kind: `outbox.${event.type}`,
      subject: record.subject,
      correlationId: record.operationKey,
      payload: JSON.stringify({
        operationKey: record.operationKey,
        from: outcome.from,
        to: outcome.to,
        attemptCount,
        code: lastError,
      }),
    },
  });
  return result.ok ? { ok: true, record: result.record } : { ok: false, reason: "STALE" };
}

export type OperationLoad =
  | { readonly ok: true; readonly operation: GithubOperation }
  | { readonly ok: false; readonly code: string };

/**
 * Reads the pinned payload of an outbox row and validates it at the boundary. The artifact store
 * checks the sha-256 recorded with the row, so a changed payload is refused, not sent.
 */
export function loadOutboxOperation(
  artifacts: Pick<ArtifactStore, "read">,
  record: OutboxRecord,
): OperationLoad {
  let bytes: Uint8Array;
  try {
    bytes = artifacts.read({ path: record.payloadRef, sha256: record.payloadHash });
  } catch {
    return { ok: false, code: "PAYLOAD_UNREADABLE" };
  }
  const parsed = parseGithubOperationPayload(bytes, record.kind);
  return parsed.ok ? { ok: true, operation: parsed.operation } : { ok: false, code: parsed.reason };
}
