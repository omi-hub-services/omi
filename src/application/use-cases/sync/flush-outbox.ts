import { isValidOperationKey } from "../../../domain/delivery/operation-marker.js";
import { backoffDelayMs } from "../../../domain/runs/retry-policy.js";
import type { RetryBudget } from "../../../domain/runs/retry-policy.js";
import type { SendOutcome } from "../../ports/github-remote.js";
import type { OutboxRecord } from "../../ports/outbox-store.js";
import {
  advanceOutboxOperation,
  loadOutboxOperation,
} from "../../services/advance-outbox-operation.js";
import { reconcileGithub } from "./reconcile-github.js";
import type { ReconcileGithubDeps, ReconcileReport } from "./reconcile-github.js";

export interface FlushOutboxDeps extends ReconcileGithubDeps {
  /** Budget for operational retries: attempts per operation, backoff base and cap. */
  readonly retryBudget: RetryBudget;
  /** Random value in [0, 1) that spreads retries; a value, so tests are deterministic. */
  readonly jitter: () => number;
  /** Most operations examined in one pass. */
  readonly batchSize: number;
}

export type FlushAttempt =
  | { readonly outcome: "succeeded"; readonly remoteIdentity: string }
  /** GitHub refused and applied nothing; the operation waits until `notBefore` (ISO-8601). */
  | { readonly outcome: "rejected_retry"; readonly code: string; readonly notBefore: string }
  | { readonly outcome: "failed"; readonly code: string }
  /** The effect may exist. The next pass reads the remote before anything is sent again. */
  | { readonly outcome: "outcome_unknown"; readonly code: string }
  /** Never sent: the payload is unusable or the attempt budget is spent. */
  | { readonly outcome: "gave_up"; readonly code: string }
  | { readonly outcome: "skipped"; readonly reason: string };

export interface FlushReport {
  readonly reconcile: ReconcileReport;
  readonly attempts: readonly ({ readonly operationKey: string } & FlushAttempt)[];
  /** Why the pass ended before the batch was done, when it did. */
  readonly stopped?: "GITHUB_UNAVAILABLE" | "RATE_LIMITED" | "OUTCOME_UNKNOWN" | "STALE";
}

/**
 * Sends the due outbox operations to GitHub, one attempt each (architecture.md §11).
 *
 * Order per pass: reconcile first (so no operation with an unknown outcome is sent again before
 * its marker was searched), then for each due `pending` operation persist `in_flight` **before**
 * the call, send, and persist what the remote answered. If GitHub cannot be read the pass ends
 * and every operation keeps its local state; a later pass continues from there and does not
 * repeat what already took effect. The pass also ends after a rate-limit refusal or an unknown
 * outcome, since further calls would meet the same problem.
 *
 * This reduces duplicates through reconciliation; it does not promise exactly-once delivery.
 */
export async function flushOutbox(deps: FlushOutboxDeps): Promise<FlushReport> {
  const reconcile = await reconcileGithub(deps);
  if (reconcile.githubUnavailable) {
    return { reconcile, attempts: [], stopped: "GITHUB_UNAVAILABLE" };
  }

  const attempts: ({ operationKey: string } & FlushAttempt)[] = [];
  const due = deps.outbox.listDue(new Date(deps.now()).toISOString(), deps.batchSize);
  for (const record of due) {
    const attempt = await attemptOne(deps, record);
    attempts.push({ operationKey: record.operationKey, ...attempt });
    switch (attempt.outcome) {
      case "rejected_retry":
        return { reconcile, attempts, stopped: "RATE_LIMITED" };
      case "outcome_unknown":
        return { reconcile, attempts, stopped: "OUTCOME_UNKNOWN" };
      case "skipped":
        if (attempt.reason === "STALE") return { reconcile, attempts, stopped: "STALE" };
        break;
      default:
        break;
    }
  }
  return { reconcile, attempts };
}

async function attemptOne(deps: FlushOutboxDeps, record: OutboxRecord): Promise<FlushAttempt> {
  // The marker is derived from the key; a key that cannot form one must never reach the remote.
  if (!isValidOperationKey(record.operationKey)) {
    return giveUp(deps, record, "INVALID_OPERATION_KEY");
  }
  const loaded = loadOutboxOperation(deps.artifacts, record);
  if (!loaded.ok) return giveUp(deps, record, loaded.code);

  const started = advanceOutboxOperation(
    deps,
    record,
    {
      type: "begin_attempt",
      now: deps.now(),
      notBefore: record.nextAttemptAt === null ? 0 : Date.parse(record.nextAttemptAt),
      attemptCount: record.attemptCount,
      maxAttempts: deps.retryBudget.maxAttempts,
    },
    { attemptCount: record.attemptCount + 1 },
  );
  if (!started.ok) {
    if (started.reason === "RETRY_BUDGET_EXHAUSTED") {
      return giveUp(deps, record, record.lastError ?? "RETRY_BUDGET_EXHAUSTED");
    }
    return { outcome: "skipped", reason: started.reason };
  }

  // The row is `in_flight` on disk from here on: a crash during the call leaves a trace that the
  // next reconcile turns into a marker search instead of a blind retry.
  let sent: SendOutcome;
  try {
    sent = await deps.github.send({
      operation: loaded.operation,
      operationKey: record.operationKey,
    });
  } catch {
    sent = { kind: "outcome_unknown", code: "SEND_FAILED" };
  }
  return recordOutcome(deps, started.record, sent);
}

function recordOutcome(
  deps: FlushOutboxDeps,
  inFlight: OutboxRecord,
  sent: SendOutcome,
): FlushAttempt {
  switch (sent.kind) {
    case "succeeded": {
      const done = advanceOutboxOperation(
        deps,
        inFlight,
        { type: "attempt_succeeded", remoteIdentity: sent.remoteIdentity },
        { remoteIdentity: sent.remoteIdentity, lastError: null },
      );
      // Not recorded as succeeded would mean another writer moved the row; the remote effect
      // exists either way and the next reconcile finds it by its marker.
      return done.ok
        ? { outcome: "succeeded", remoteIdentity: sent.remoteIdentity }
        : { outcome: "skipped", reason: "STALE" };
    }
    case "rejected_retryable": {
      const wait = Math.max(
        sent.retryAfterMs ?? 0,
        backoffDelayMs(inFlight.attemptCount - 1, deps.jitter(), deps.retryBudget),
      );
      const notBeforeMs = deps.now() + wait;
      const moved = advanceOutboxOperation(
        deps,
        inFlight,
        { type: "attempt_rejected_retry" },
        { notBeforeMs, lastError: sent.code },
      );
      return moved.ok
        ? {
            outcome: "rejected_retry",
            code: sent.code,
            notBefore: new Date(notBeforeMs).toISOString(),
          }
        : { outcome: "skipped", reason: "STALE" };
    }
    case "rejected_final": {
      const moved = advanceOutboxOperation(
        deps,
        inFlight,
        { type: "attempt_rejected_final" },
        { lastError: sent.code },
      );
      return moved.ok
        ? { outcome: "failed", code: sent.code }
        : { outcome: "skipped", reason: "STALE" };
    }
    case "outcome_unknown": {
      const moved = advanceOutboxOperation(
        deps,
        inFlight,
        { type: "attempt_outcome_unknown" },
        { lastError: sent.code },
      );
      return moved.ok
        ? { outcome: "outcome_unknown", code: sent.code }
        : { outcome: "skipped", reason: "STALE" };
    }
  }
}

function giveUp(deps: FlushOutboxDeps, record: OutboxRecord, code: string): FlushAttempt {
  const moved = advanceOutboxOperation(
    deps,
    record,
    { type: "give_up", reason: code },
    { lastError: code },
  );
  return moved.ok ? { outcome: "gave_up", code } : { outcome: "skipped", reason: "STALE" };
}
