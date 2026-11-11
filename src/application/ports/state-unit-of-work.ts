import type { ApprovalRequest } from "../../domain/approvals/approval.js";
import type { RunStatus } from "../../domain/runs/workflow-run.js";
import type { StepStatus } from "../../domain/runs/step-run.js";

/** The state row to move, guarded by compare-and-swap on its `version`. */
export type StateTarget =
  /** Init may queue a remote intent before a project/run row exists. Requires `outbox`. */
  | { readonly kind: "outbox_intent" }
  | { readonly kind: "approval_request"; readonly request: ApprovalRequest }
  | {
      readonly kind: "approval_decision";
      readonly request: ApprovalRequest;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: "workflow_run";
      readonly id: string;
      readonly expectedVersion: number;
      readonly toStatus: RunStatus;
    }
  | {
      readonly kind: "step_run";
      readonly id: string;
      readonly expectedVersion: number;
      readonly toStatus: StepStatus;
    };

/** One append-only audit record. `payload` is JSON text; the runtime supplies ids and time. */
export interface AuditEvent {
  readonly eventId: string;
  readonly kind: string;
  readonly subject: string;
  readonly runId?: string;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly payload: string;
}

/** One external action to perform later; `operationKey` makes it idempotent. */
export interface OutboxEntry {
  readonly operationKey: string;
  readonly kind: string;
  readonly subject: string;
  readonly payloadRef: string;
  readonly payloadHash: string;
}

/** The lease generation the writer believes it holds; checked in the same transaction. */
export interface LeaseFence {
  readonly resourceKey: string;
  readonly owner: string;
  readonly generation: number;
}

export interface StateChange {
  readonly target: StateTarget;
  /** ISO-8601 UTC time of the change: `updated_at`, `occurred_at`, outbox timestamps. */
  readonly at: string;
  readonly event: AuditEvent;
  readonly outbox?: OutboxEntry;
  readonly fence?: LeaseFence;
}

export type StateRejection =
  "NOT_FOUND" | "STALE_VERSION" | "STALE_LEASE" | "LEASE_EXPIRED" | "ALREADY_EXISTS";

export type StateCommitResult =
  | { readonly ok: true; readonly newVersion: number; readonly eventSequence: number }
  | { readonly ok: false; readonly reason: StateRejection };

/**
 * Applies a state change, its audit event and its optional outbox entry in one short,
 * synchronous transaction: all three commit or none do. A rejection (stale version, stale or
 * expired lease, missing row) writes nothing and is returned, never thrown. Any other failure
 * throws after the transaction rolled back.
 */
export interface StateUnitOfWork {
  commit(change: StateChange): StateCommitResult;
}
