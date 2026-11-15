import { applyTransition, ruleBuilder } from "../shared/transition.js";
import type { TransitionOutcome, TransitionRule } from "../shared/transition.js";

/** Step states from architecture.md §8. `failed` is one attempt's outcome, not the task's. */
export const STEP_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting_approval",
  "waiting_resource",
  "succeeded",
  "failed",
  "paused",
  "interrupted",
  "cancelled",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * Events reported by an attempt carry the attempt generation they belong to. A late event from
 * an older attempt must never overwrite a newer one (design-patterns.md §4, §8).
 */
interface AttemptScoped {
  readonly attempt: number;
  readonly currentAttempt: number;
}

export type StepEvent =
  | { readonly type: "dependencies_met"; readonly inputsValid: boolean; readonly inScope: boolean }
  | {
      readonly type: "start";
      readonly leaseHeld: boolean;
      readonly executorEligible: boolean;
      readonly contextSaved: boolean;
    }
  | (AttemptScoped & {
      readonly type: "succeed";
      readonly resultValid: boolean;
      readonly stepGatePassed: boolean;
    })
  | (AttemptScoped & { readonly type: "fail" })
  | (AttemptScoped & { readonly type: "interrupt" })
  | (AttemptScoped & { readonly type: "wait_resource"; readonly previousWriterStopped: boolean })
  | { readonly type: "wait_approval" }
  | { readonly type: "approval_granted"; readonly approvalValid: boolean }
  | { readonly type: "resource_available"; readonly candidateAvailable: boolean }
  | {
      readonly type: "reconciled";
      readonly reconciliationDone: boolean;
      readonly oldProcessGone: boolean;
      readonly checkpointValid: boolean;
    }
  | { readonly type: "retry_authorized"; readonly reworkAllowsRetry: boolean }
  | { readonly type: "pause"; readonly writerStopped: boolean }
  | { readonly type: "resume"; readonly checkpointValid: boolean }
  | { readonly type: "cancel"; readonly writerStopped: boolean };

export type StepRefusal =
  | "INPUT_INVALID"
  | "OUT_OF_SCOPE"
  | "LEASE_NOT_HELD"
  | "NO_ELIGIBLE_EXECUTOR"
  | "CONTEXT_NOT_SAVED"
  | "STALE_ATTEMPT"
  | "RESULT_INVALID"
  | "STEP_GATE_FAILED"
  | "WRITER_STILL_ACTIVE"
  | "APPROVAL_INVALID"
  | "NO_CANDIDATE_AVAILABLE"
  | "RECONCILIATION_PENDING"
  | "OLD_PROCESS_STILL_RUNNING"
  | "CHECKPOINT_INVALID"
  | "REWORK_BUDGET_SPENT";

const rule = ruleBuilder<StepStatus, StepEvent, StepRefusal>();

const stale = (e: AttemptScoped): StepRefusal | undefined =>
  e.attempt === e.currentAttempt ? undefined : "STALE_ATTEMPT";

const cancellable: readonly StepStatus[] = [
  "pending",
  "ready",
  "running",
  "waiting_approval",
  "waiting_resource",
  "failed",
  "paused",
  "interrupted",
];

export const STEP_RULES: readonly TransitionRule<StepStatus, StepEvent, StepRefusal>[] = [
  rule("pending", "dependencies_met", "ready", (e) => {
    if (!e.inputsValid) return "INPUT_INVALID";
    return e.inScope ? undefined : "OUT_OF_SCOPE";
  }),
  rule("ready", "start", "running", (e) => {
    if (!e.leaseHeld) return "LEASE_NOT_HELD";
    if (!e.executorEligible) return "NO_ELIGIBLE_EXECUTOR";
    return e.contextSaved ? undefined : "CONTEXT_NOT_SAVED";
  }),
  rule("running", "succeed", "succeeded", (e) => {
    const refusal = stale(e);
    if (refusal !== undefined) return refusal;
    if (!e.resultValid) return "RESULT_INVALID";
    return e.stepGatePassed ? undefined : "STEP_GATE_FAILED";
  }),
  rule("running", "fail", "failed", stale),
  rule("running", "interrupt", "interrupted", stale),
  rule("running", "wait_resource", "waiting_resource", (e) => {
    const refusal = stale(e);
    if (refusal !== undefined) return refusal;
    return e.previousWriterStopped ? undefined : "WRITER_STILL_ACTIVE";
  }),
  rule("running", "wait_approval", "waiting_approval"),
  rule("waiting_approval", "approval_granted", "ready", (e) =>
    e.approvalValid ? undefined : "APPROVAL_INVALID",
  ),
  rule("waiting_resource", "resource_available", "ready", (e) =>
    e.candidateAvailable ? undefined : "NO_CANDIDATE_AVAILABLE",
  ),
  rule("interrupted", "reconciled", "ready", (e) => {
    if (!e.reconciliationDone) return "RECONCILIATION_PENDING";
    if (!e.oldProcessGone) return "OLD_PROCESS_STILL_RUNNING";
    return e.checkpointValid ? undefined : "CHECKPOINT_INVALID";
  }),
  // The rework controller (rework-policy.ts) owns the quality budget; this rule only obeys it.
  rule("failed", "retry_authorized", "ready", (e) =>
    e.reworkAllowsRetry ? undefined : "REWORK_BUDGET_SPENT",
  ),
  rule("ready", "pause", "paused"),
  rule("running", "pause", "paused", (e) => (e.writerStopped ? undefined : "WRITER_STILL_ACTIVE")),
  rule("paused", "resume", "ready", (e) => (e.checkpointValid ? undefined : "CHECKPOINT_INVALID")),
  ...cancellable.map((from) =>
    rule(from, "cancel", "cancelled", (e) =>
      from === "running" && !e.writerStopped ? "WRITER_STILL_ACTIVE" : undefined,
    ),
  ),
];

export function transitionStep(
  from: StepStatus,
  event: StepEvent,
): TransitionOutcome<StepStatus, StepRefusal> {
  return applyTransition(STEP_RULES, from, event);
}
