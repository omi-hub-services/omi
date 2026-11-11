import type { ExecutionOutcome } from "../../../application/contracts/agent-execution.js";
import { redactDiagnostic } from "../../processes/redact-diagnostic.js";
import type { ProcessExit } from "../../processes/supervised-process.js";
import type { CodexStreamSummary } from "./codex-stream.js";

export interface CodexClassification {
  outcome: ExecutionOutcome;
  reason: string;
  diagnostic?: string;
  quota?: { limitType?: string; resetsAt?: number };
}

// Synthetic error fixtures, pending real captures. Do not match a bare 429 or mere flag name.
const MODEL =
  /\b(model_not_found|unsupported_model)\b|\bmodel\b[^\n]{0,100}(not supported|does not exist|not found|not available)|(?:unsupported|unknown|invalid) model\b/i;
const EFFORT =
  /\b(unsupported|invalid)[ _-](reasoning[ _-])?effort\b|\b(?:model_reasoning_effort|reasoning[ _]effort)\b[^\n]{0,100}(not supported|unsupported|invalid|unknown)|(?:unsupported|invalid|unknown)[^\n]{0,100}\b(?:model_reasoning_effort|reasoning[ _]effort)\b/i;
const AUTH =
  /\b(not logged in|login required|authentication[_ ](?:failed|required)|unauthorized|refresh_token_reused|invalid_api_key)\b|please (?:run ['"]?(?:codex )?login|log in)|\b(?:access|refresh) token\b[^\n]{0,60}(expired|invalid|revoked)/i;
const LIMIT =
  /\b(usage_limit_reached|rate_limit_exceeded|usage limit|rate limit|too many requests)\b|hit your (?:usage |weekly )?limit/i;

export function classifyCodexRun(
  summary: CodexStreamSummary,
  exit: ProcessExit,
): CodexClassification {
  const text = [summary.errorCodes.join(" "), summary.errorText, exit.stderr].join("\n");
  const diagnostic = redactDiagnostic([summary.errorText, exit.stderr].join("\n"), 500);
  const extra = diagnostic === "" ? {} : { diagnostic };
  if (exit.stdoutOverflow) return { outcome: "failed", reason: "output_limit_exceeded", ...extra };
  const success =
    exit.exitCode === 0 && exit.signal === null && summary.completedTurns > 0 && !summary.errorSeen;
  if (!success) {
    if (exit.cancelRequested) return { outcome: "cancelled", reason: "cancel_requested", ...extra };
    if (exit.timedOut) return { outcome: "timed-out", reason: "timeout", ...extra };
    if (MODEL.test(text))
      return { outcome: "unsupported-model-or-effort", reason: "unsupported_model", ...extra };
    if (EFFORT.test(text))
      return { outcome: "unsupported-model-or-effort", reason: "unsupported_effort", ...extra };
    if (AUTH.test(text)) return { outcome: "auth-required", reason: "login_required", ...extra };
    if (LIMIT.test(text) || summary.quota?.status === "rejected") {
      return {
        outcome: "usage-limit",
        reason: "usage_limit_reached",
        ...extra,
        ...(summary.quota === undefined
          ? {}
          : { quota: { limitType: summary.quota.limitType, resetsAt: summary.quota.resetsAt } }),
      };
    }
  }
  if (summary.unparsedLines > 0)
    return { outcome: "malformed-output", reason: "unparsed_stdout", ...extra };
  if (success) {
    if (summary.sessionId === undefined)
      return { outcome: "malformed-output", reason: "missing_thread_event" };
    return { outcome: "succeeded", reason: "completed" };
  }
  if (
    exit.exitCode === 0 &&
    exit.signal === null &&
    summary.completedTurns === 0 &&
    !summary.errorSeen
  )
    return { outcome: "malformed-output", reason: "missing_completion_event", ...extra };
  return {
    outcome: "failed",
    reason: summary.errorSeen ? "turn_reported_error" : "nonzero_exit",
    ...extra,
  };
}
