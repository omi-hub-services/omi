import type { GithubOperation } from "../contracts/github-operation.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import { flushOutbox } from "../use-cases/sync/flush-outbox.js";
import type { FlushOutboxDeps } from "../use-cases/sync/flush-outbox.js";
import { reconcileGithub } from "../use-cases/sync/reconcile-github.js";
import { queueGithubOperation } from "./queue-github-operation.js";
import type { GithubOperationQueueDeps } from "./queue-github-operation.js";

export type DeliverGithubOperationDeps = GithubOperationQueueDeps & FlushOutboxDeps;

export type DeliveryOutcome =
  | { readonly kind: "succeeded"; readonly remoteIdentity: string | null }
  /** Not settled yet (rate limit, unknown outcome inside the grace period); call again later. */
  | { readonly kind: "pending"; readonly operationKey: string; readonly state: string }
  /** GitHub refused and applied nothing; the row is `failed` until a recorded decision reopens it. */
  | { readonly kind: "failed"; readonly operationKey: string; readonly code: string };

/**
 * Queues one operation (a durable intent before any remote I/O) and runs the normal flush for
 * that key only: reconcile first, then at most one send. A row whose outcome is unknown is never
 * sent again before its read-back (ADR-0025), so calling this again after a crash is safe.
 */
export async function deliverGithubOperation(
  deps: DeliverGithubOperationDeps,
  operationKey: string,
  operation: GithubOperation,
): Promise<DeliveryOutcome> {
  queueGithubOperation(deps, operationKey, operation);
  await flushOutbox({ ...deps, outbox: scopedOutbox(deps.outbox, operationKey) });
  const row = deps.outbox.get(operationKey);
  if (row?.state === "succeeded") return { kind: "succeeded", remoteIdentity: row.remoteIdentity };
  if (row?.state === "failed") {
    return { kind: "failed", operationKey, code: row.lastError ?? "OPERATION_FAILED" };
  }
  return { kind: "pending", operationKey, state: row?.state ?? "missing" };
}

/** Settles an earlier attempt of this key, if any, without sending anything. */
export async function reconcileGithubOperation(
  deps: FlushOutboxDeps,
  operationKey: string,
): Promise<void> {
  await reconcileGithub({ ...deps, outbox: scopedOutbox(deps.outbox, operationKey) });
}

/** A delivery call must not flush or reconcile another task's queued operations. */
function scopedOutbox(outbox: OutboxStore, key: string): OutboxStore {
  return {
    get: outbox.get.bind(outbox),
    transition: outbox.transition.bind(outbox),
    listUnresolved: () => outbox.listUnresolved().filter((row) => row.operationKey === key),
    listDue: (now, limit) =>
      outbox
        .listDue(now, Number.MAX_SAFE_INTEGER)
        .filter((row) => row.operationKey === key)
        .slice(0, limit),
  };
}
