import { applyTransition, ruleBuilder } from "../shared/transition.js";
import type { TransitionOutcome, TransitionRule } from "../shared/transition.js";

/**
 * One workflow run for one task. `succeeded` means every step and mandatory gate passed; it
 * does not make the task Done (the task needs the confirmed merge, see task-status.ts).
 */
export const RUN_STATUSES = [
  "pending",
  "running",
  "waiting_approval",
  "waiting_resource",
  "paused",
  "interrupted",
  "blocked",
  "succeeded",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunEvent =
  | {
      readonly type: "start";
      /** Template hash is pinned so a template update cannot change a running run. */
      readonly templateHash: string;
      readonly otherActiveRunForTask: boolean;
    }
  | { readonly type: "wait_approval" }
  | { readonly type: "approval_granted"; readonly approvalValid: boolean }
  | { readonly type: "wait_resource"; readonly writerStopped: boolean }
  | { readonly type: "resource_available"; readonly candidateAvailable: boolean }
  | { readonly type: "pause"; readonly checkpointSaved: boolean; readonly writerStopped: boolean }
  | { readonly type: "resume"; readonly checkpointValid: boolean }
  | { readonly type: "interrupt" }
  | {
      readonly type: "reconciled";
      readonly reconciliationDone: boolean;
      readonly oldProcessGone: boolean;
      readonly checkpointValid: boolean;
    }
  | {
      readonly type: "complete";
      readonly allStepsSucceeded: boolean;
      readonly mandatoryGatesPassed: boolean;
    }
  | { readonly type: "block"; readonly checkpointSaved: boolean }
  | { readonly type: "reopen"; readonly poDecisionId: string }
  | { readonly type: "cancel"; readonly writerStopped: boolean };

export type RunRefusal =
  | "TEMPLATE_NOT_PINNED"
  | "ACTIVE_RUN_EXISTS"
  | "APPROVAL_INVALID"
  | "WRITER_STILL_ACTIVE"
  | "NO_CANDIDATE_AVAILABLE"
  | "CHECKPOINT_MISSING"
  | "CHECKPOINT_INVALID"
  | "RECONCILIATION_PENDING"
  | "OLD_PROCESS_STILL_RUNNING"
  | "STEPS_NOT_SUCCEEDED"
  | "MANDATORY_GATE_NOT_PASSED"
  | "REOPEN_DECISION_MISSING";

const rule = ruleBuilder<RunStatus, RunEvent, RunRefusal>();

const cancellable: readonly RunStatus[] = [
  "pending",
  "running",
  "waiting_approval",
  "waiting_resource",
  "paused",
  "interrupted",
  "blocked",
];

export const RUN_RULES: readonly TransitionRule<RunStatus, RunEvent, RunRefusal>[] = [
  rule("pending", "start", "running", (e) => {
    if (e.templateHash.trim() === "") return "TEMPLATE_NOT_PINNED";
    return e.otherActiveRunForTask ? "ACTIVE_RUN_EXISTS" : undefined;
  }),
  rule("running", "wait_approval", "waiting_approval"),
  rule("waiting_approval", "approval_granted", "running", (e) =>
    e.approvalValid ? undefined : "APPROVAL_INVALID",
  ),
  rule("running", "wait_resource", "waiting_resource", (e) =>
    e.writerStopped ? undefined : "WRITER_STILL_ACTIVE",
  ),
  rule("waiting_resource", "resource_available", "running", (e) =>
    e.candidateAvailable ? undefined : "NO_CANDIDATE_AVAILABLE",
  ),
  ...(["running", "waiting_approval", "waiting_resource"] as const).map((from) =>
    rule(from, "pause", "paused", (e) => {
      if (!e.checkpointSaved) return "CHECKPOINT_MISSING";
      return e.writerStopped ? undefined : "WRITER_STILL_ACTIVE";
    }),
  ),
  rule("paused", "resume", "running", (e) =>
    e.checkpointValid ? undefined : "CHECKPOINT_INVALID",
  ),
  rule("running", "interrupt", "interrupted"),
  rule("interrupted", "reconciled", "running", (e) => {
    if (!e.reconciliationDone) return "RECONCILIATION_PENDING";
    if (!e.oldProcessGone) return "OLD_PROCESS_STILL_RUNNING";
    return e.checkpointValid ? undefined : "CHECKPOINT_INVALID";
  }),
  rule("running", "complete", "succeeded", (e) => {
    if (!e.allStepsSucceeded) return "STEPS_NOT_SUCCEEDED";
    return e.mandatoryGatesPassed ? undefined : "MANDATORY_GATE_NOT_PASSED";
  }),
  rule("running", "block", "blocked", (e) =>
    e.checkpointSaved ? undefined : "CHECKPOINT_MISSING",
  ),
  rule("blocked", "reopen", "running", (e) =>
    e.poDecisionId.trim() === "" ? "REOPEN_DECISION_MISSING" : undefined,
  ),
  ...cancellable.map((from) =>
    rule(from, "cancel", "cancelled", (e) =>
      from === "running" && !e.writerStopped ? "WRITER_STILL_ACTIVE" : undefined,
    ),
  ),
];

export function transitionRun(
  from: RunStatus,
  event: RunEvent,
): TransitionOutcome<RunStatus, RunRefusal> {
  return applyTransition(RUN_RULES, from, event);
}
