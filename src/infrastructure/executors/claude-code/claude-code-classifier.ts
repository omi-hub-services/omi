import type { ExecutionOutcome } from "../../../application/contracts/agent-execution.js";
import { redactDiagnostic } from "../../processes/redact-diagnostic.js";
import type { ClaudeStreamSummary } from "./claude-code-stream.js";

export interface ClaudeRunFacts {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The caller asked for cancellation while the process was running. */
  cancelRequested: boolean;
  timedOut: boolean;
  stdoutOverflow: boolean;
  stderr: string;
}

export interface ClaudeClassification {
  outcome: ExecutionOutcome;
  reason: string;
  authMode: "subscription" | "api-key" | "unknown";
  diagnostic?: string;
  quota?: { limitType?: string; resetsAt?: number };
}

// Text patterns are best effort. Only the unknown-model case (stderr tag
// `[claude-code:unrecognized_model]`, exit 1 with `is_error`) is backed by a live run (ADR-0013);
// the others follow the CLI's documented wording and are covered by fixtures that mirror it.
// Re-check them with the live test on every CLI upgrade (ADR-0023).
const UNSUPPORTED_MODEL =
  /unrecognized_model|issue with the selected model|may not exist or you may not have access/i;
const UNSUPPORTED_EFFORT =
  /--effort\b|(unsupported|invalid|not supported)[^\n]{0,60}\beffort\b|\beffort\b[^\n]{0,60}(unsupported|invalid|not supported)/i;
const AUTH =
  /not logged in|please run \/login|login required|invalid (api key|credentials|x-api-key)|authentication[_ ](failed|error|required)|oauth[^\n]{0,40}(expired|revoked|invalid)|\bunauthorized\b/i;
const USAGE_LIMIT =
  /usage limit|limit reached|hit your (usage |weekly |5-hour )?limit|5-hour limit|weekly limit|rate[ _-]?limit|too many requests/i;
// Older CLIs ended a limit message with `|<epoch seconds>`.
const TRAILING_EPOCH = /\|\s*(\d{10})\b/;

const DIAGNOSTIC_MAX_CHARS = 500;

function describe(
  summary: ClaudeStreamSummary,
  facts: ClaudeRunFacts,
): { text: string; diagnostic: string | undefined } {
  const text = [summary.result?.isError === true ? summary.result.text : "", facts.stderr]
    .filter((part) => part !== "")
    .join("\n");
  const diagnostic = redactDiagnostic(text, DIAGNOSTIC_MAX_CHARS);
  return { text, diagnostic: diagnostic === "" ? undefined : diagnostic };
}

function authModeOf(summary: ClaudeStreamSummary): ClaudeClassification["authMode"] {
  const source = summary.init?.apiKeySource;
  if (source === undefined) return "unknown";
  return source === "none" ? "subscription" : "api-key";
}

/**
 * Classifies one finished run. Exit code, `result.subtype` and `result.is_error` are read
 * together because none is reliable alone (ADR-0013 finding 1): an unknown model gives
 * `subtype: "success"` with `is_error: true`, and a SIGINT-cancelled run exits 0 with
 * `subtype: "error_during_execution"`.
 *
 * Order matters: a caller-requested cancel or a timeout outranks the CLI's own error text, and
 * model, login and quota errors outrank "malformed" so that a plain failure is not mistaken for
 * CLI drift.
 */
export function classifyClaudeRun(
  summary: ClaudeStreamSummary,
  facts: ClaudeRunFacts,
): ClaudeClassification {
  const authMode = authModeOf(summary);
  const { result } = summary;
  const succeeded =
    facts.exitCode === 0 &&
    facts.signal === null &&
    result?.subtype === "success" &&
    !result.isError;

  if (facts.stdoutOverflow) {
    return { outcome: "failed", reason: "output_limit_exceeded", authMode };
  }

  if (succeeded) {
    if (summary.unparsedLines > 0) {
      return { outcome: "malformed-output", reason: "unparsed_stdout", authMode };
    }
    if (summary.init === undefined) {
      return { outcome: "malformed-output", reason: "missing_init_event", authMode };
    }
    if (authMode === "api-key") {
      // The run worked but was billed to something other than the subscription login.
      return { outcome: "failed", reason: "api_key_auth_detected", authMode };
    }
    return { outcome: "succeeded", reason: "completed", authMode };
  }

  const { text, diagnostic } = describe(summary, facts);
  const withDiagnostic = diagnostic === undefined ? {} : { diagnostic };

  if (facts.cancelRequested) {
    return { outcome: "cancelled", reason: "cancel_requested", authMode, ...withDiagnostic };
  }
  if (facts.timedOut) {
    return { outcome: "timed-out", reason: "timeout", authMode, ...withDiagnostic };
  }
  if (UNSUPPORTED_MODEL.test(text)) {
    return {
      outcome: "unsupported-model-or-effort",
      reason: "unsupported_model",
      authMode,
      ...withDiagnostic,
    };
  }
  if (UNSUPPORTED_EFFORT.test(text)) {
    return {
      outcome: "unsupported-model-or-effort",
      reason: "unsupported_effort",
      authMode,
      ...withDiagnostic,
    };
  }
  if (result?.apiErrorStatus === 401 || AUTH.test(text)) {
    return { outcome: "auth-required", reason: "login_required", authMode, ...withDiagnostic };
  }
  if (
    result?.apiErrorStatus === 429 ||
    summary.quota?.status === "rejected" ||
    USAGE_LIMIT.test(text)
  ) {
    return {
      outcome: "usage-limit",
      reason: "usage_limit_reached",
      authMode,
      ...withDiagnostic,
      quota: quotaOf(summary, result?.text ?? ""),
    };
  }
  if (summary.invalidResult) {
    return {
      outcome: "malformed-output",
      reason: "invalid_result_event",
      authMode,
      ...withDiagnostic,
    };
  }
  if (result === undefined) {
    if (facts.exitCode === 0 || summary.unparsedLines > 0) {
      return {
        outcome: "malformed-output",
        reason: summary.unparsedLines > 0 ? "unparsed_stdout" : "missing_result_event",
        authMode,
        ...withDiagnostic,
      };
    }
    return { outcome: "failed", reason: "exit_without_result", authMode, ...withDiagnostic };
  }
  return {
    outcome: "failed",
    reason: result.isError ? "result_reported_error" : "nonzero_exit",
    authMode,
    ...withDiagnostic,
  };
}

function quotaOf(
  summary: ClaudeStreamSummary,
  resultText: string,
): { limitType?: string; resetsAt?: number } {
  const observed = summary.quota;
  const epoch = TRAILING_EPOCH.exec(resultText)?.[1];
  const resetsAt = observed?.resetsAt ?? (epoch === undefined ? undefined : Number(epoch));
  return {
    ...(observed?.limitType === undefined ? {} : { limitType: observed.limitType }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}
