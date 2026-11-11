import type { Effort } from "../agents/capability.js";
import { applyTransition, ruleBuilder } from "../shared/transition.js";
import type { TransitionOutcome } from "../shared/transition.js";

/** An attempt is never resumed or retried; a retry creates another attempt. */
export const AGENT_ATTEMPT_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type AgentAttemptStatus = (typeof AGENT_ATTEMPT_STATUSES)[number];
type AttemptRefusal =
  "STALE_GENERATION" | "WRITER_STILL_ACTIVE" | "RESULT_INVALID" | "LEASE_NOT_HELD";
export type AgentAttemptEvent =
  | { readonly type: "start"; readonly leaseHeld: boolean }
  | {
      [K in "succeed" | "fail" | "interrupt" | "cancel"]: {
        readonly type: K;
        readonly generation: number;
        readonly currentGeneration: number;
        readonly writerStopped: boolean;
        readonly resultValid: boolean;
      };
    }["succeed" | "fail" | "interrupt" | "cancel"];
const rule = ruleBuilder<AgentAttemptStatus, AgentAttemptEvent, AttemptRefusal>();
const finish = (
  event: Extract<AgentAttemptEvent, { generation: number }>,
): AttemptRefusal | undefined => {
  if (event.generation !== event.currentGeneration) return "STALE_GENERATION";
  return event.writerStopped ? undefined : "WRITER_STILL_ACTIVE";
};
export const AGENT_ATTEMPT_RULES = [
  rule("pending", "start", "running", (event) => (event.leaseHeld ? undefined : "LEASE_NOT_HELD")),
  rule(
    "running",
    "succeed",
    "succeeded",
    (event) => finish(event) ?? (event.resultValid ? undefined : "RESULT_INVALID"),
  ),
  rule("running", "fail", "failed", finish),
  rule("running", "interrupt", "interrupted", finish),
  rule("running", "cancel", "cancelled", finish),
  rule("pending", "cancel", "cancelled", finish),
];
export function transitionAgentAttempt(
  from: AgentAttemptStatus,
  event: AgentAttemptEvent,
): TransitionOutcome<AgentAttemptStatus, AttemptRefusal> {
  return applyTransition(AGENT_ATTEMPT_RULES, from, event);
}

/** The requested choice and separately reported facts survive every profile switch as attempts. */
export interface AttemptSelection {
  readonly executor: "claude-code" | "codex";
  readonly profileId: string;
  readonly model: string;
  readonly effort: Effort;
}

export interface AttemptSettings {
  readonly chosen: AttemptSelection;
  /** Missing means unreported; never fill actual values from the requested settings. */
  readonly actualModel?: string;
  readonly actualEffort?: Effort;
}
