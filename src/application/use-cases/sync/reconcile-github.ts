import type { ArtifactStore } from "../../ports/artifact-store.js";
import type { GithubRemote, LookupOutcome } from "../../ports/github-remote.js";
import type { OutboxRecord } from "../../ports/outbox-store.js";
import {
  advanceOutboxOperation,
  loadOutboxOperation,
} from "../../services/advance-outbox-operation.js";
import type { OutboxRuntime } from "../../services/advance-outbox-operation.js";

export interface ReconcileGithubDeps extends OutboxRuntime {
  readonly github: GithubRemote;
  readonly artifacts: Pick<ArtifactStore, "read">;
  /**
   * How long after an unknown outcome the remote's silence is not yet trusted: a request that
   * timed out may still be running on the other side. Must exceed the adapter's request timeout.
   */
  readonly reconcileGraceMs: number;
}

export type ReconcileResult =
  /** The marker was found: the operation took effect and is now recorded as succeeded. */
  | { readonly outcome: "succeeded"; readonly remoteIdentity: string }
  /** Nothing on the remote after the grace period: the operation is safe to send again. */
  | { readonly outcome: "pending" }
  /** Nothing found yet, but too soon after the attempt to trust that; try again later. */
  | { readonly outcome: "waiting" }
  /** The payload cannot be read or validated, so the remote cannot be searched. */
  | { readonly outcome: "unreadable"; readonly code: string }
  /** Not examined because GitHub could not be read earlier in this pass. */
  | { readonly outcome: "deferred" }
  | { readonly outcome: "unavailable"; readonly code: string }
  /** Another writer changed the row first. */
  | { readonly outcome: "stale" };

export interface ReconcileReport {
  readonly entries: readonly ({ readonly operationKey: string } & ReconcileResult)[];
  /** True when a read-back failed; the remaining operations were left untouched. */
  readonly githubUnavailable: boolean;
}

/**
 * Settles every outbox operation whose remote outcome is not known (architecture.md §11):
 * an `in_flight` row can only be left by a crash or restart, so it becomes `outcome_unknown`
 * first; every `outcome_unknown` row is then searched on the remote by its operation marker.
 * Found means succeeded; absent after the grace period means pending again; anything else
 * changes nothing. This never sends an operation, so it cannot create a duplicate.
 *
 * Run it serially with `flushOutbox` from the single runtime writer; it does not lock.
 */
export async function reconcileGithub(deps: ReconcileGithubDeps): Promise<ReconcileReport> {
  const entries: ({ operationKey: string } & ReconcileResult)[] = [];
  let githubUnavailable = false;

  for (const listed of deps.outbox.listUnresolved()) {
    if (githubUnavailable) {
      entries.push({ operationKey: listed.operationKey, outcome: "deferred" });
      continue;
    }
    const result = await reconcileOne(deps, listed);
    if (result.outcome === "unavailable") githubUnavailable = true;
    entries.push({ operationKey: listed.operationKey, ...result });
  }
  return { entries, githubUnavailable };
}

async function reconcileOne(
  deps: ReconcileGithubDeps,
  listed: OutboxRecord,
): Promise<ReconcileResult> {
  let record = listed;
  if (record.state === "in_flight") {
    const recovered = advanceOutboxOperation(
      deps,
      record,
      { type: "attempt_outcome_unknown" },
      { lastError: "INTERRUPTED" },
    );
    if (!recovered.ok) return { outcome: "stale" };
    record = recovered.record;
  }

  const loaded = loadOutboxOperation(deps.artifacts, record);
  if (!loaded.ok) return { outcome: "unreadable", code: loaded.code };

  let found: LookupOutcome;
  try {
    found = await deps.github.lookup({
      operation: loaded.operation,
      operationKey: record.operationKey,
      notBefore: record.createdAt,
    });
  } catch {
    found = { kind: "unavailable", code: "LOOKUP_FAILED" };
  }

  switch (found.kind) {
    case "found": {
      const done = advanceOutboxOperation(
        deps,
        record,
        { type: "reconciled_found", remoteIdentity: found.remoteIdentity },
        { remoteIdentity: found.remoteIdentity, lastError: null },
      );
      return done.ok
        ? { outcome: "succeeded", remoteIdentity: found.remoteIdentity }
        : { outcome: "stale" };
    }
    case "absent": {
      const reopened = advanceOutboxOperation(deps, record, {
        type: "reconciled_absent",
        now: deps.now(),
        outcomeUnknownSince: Date.parse(record.updatedAt),
        graceMs: deps.reconcileGraceMs,
      });
      if (reopened.ok) return { outcome: "pending" };
      return reopened.reason === "RECONCILE_TOO_EARLY"
        ? { outcome: "waiting" }
        : { outcome: "stale" };
    }
    case "unavailable":
      return { outcome: "unavailable", code: found.code };
  }
}
