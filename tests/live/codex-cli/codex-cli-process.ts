// OMI-003 PoC support: spawn codex exec and parse its JSONL events.
// This is test-only code. The production adapter is OMI-014 under
// src/infrastructure/executors/codex/ and must not import from here.
import { spawn } from "node:child_process";

/** Variables copied from the parent environment into the child. Everything else is dropped. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;

/** Variables that would let the CLI authenticate with something other than the profile login. */
export const FORBIDDEN_AUTH_ENV = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_AUTH_TOKEN",
] as const;

/**
 * Builds the child environment from an allowlist, so API keys, OAuth tokens and the parent
 * Codex session variables never leak into the worker.
 */
export function buildWorkerEnv(
  parent: NodeJS.ProcessEnv,
  codexHome: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  env["CODEX_HOME"] = codexHome;
  return env;
}

export type StreamEvent = Record<string, unknown> & { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one JSONL line; returns undefined for non-JSON or untyped lines. */
export function parseStreamLine(line: string): StreamEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") return undefined;
  return { ...parsed, type: parsed["type"] };
}

export interface CliRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  events: StreamEvent[];
  unparsedStdoutLines: number;
  stderr: string;
  /** Whether any member of the child's process group was still alive when the child closed. */
  groupAliveAtClose: boolean;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  /** Set when the run was cancelled: which signal was sent and how long the exit took. */
  cancel?: {
    signal: NodeJS.Signals;
    afterMs: number;
    exitAfterSignalMs: number;
    escalated: boolean;
  };
}

export interface CliRunOptions {
  args: readonly string[];
  /** Prompt text, written to stdin (never concatenated into a command line). */
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  /** Hard limit; the process group is killed with SIGKILL when reached. */
  timeoutMs: number;
  /** Send a signal after the selected event; kill the group if the grace period expires. */
  cancelOn?: {
    eventType: string;
    delayMs: number;
    signal: NodeJS.Signals;
    graceMs: number;
  };
}

export function runCodex(options: CliRunOptions): Promise<CliRun> {
  const started = Date.now();
  // detached: the child leads its own process group, so a terminal Ctrl-C does not reach it and
  // the group can be killed as a last resort without touching unrelated Codex sessions.
  const child = spawn("codex", options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {
    // EPIPE when the CLI exits before reading stdin (e.g. argument errors); the exit code reports it.
  });
  child.stdin.end(options.prompt);

  const events: StreamEvent[] = [];
  let unparsed = 0;
  let stdoutBuffer = "";
  let stderr = "";
  let cancelScheduled = false;
  let cancelSentAt: number | undefined;
  let escalated = false;
  let timedOut = false;
  let outputLimitExceeded = false;
  let closed = false;
  let stdoutBytes = 0;
  const timers: NodeJS.Timeout[] = [];

  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone.
    }
  };

  const sendCancel = () => {
    const cancelOn = options.cancelOn;
    if (cancelOn === undefined || closed || child.exitCode !== null || child.signalCode !== null)
      return;
    if (!child.kill(cancelOn.signal)) return;
    cancelSentAt = Date.now();
    timers.push(
      setTimeout(() => {
        escalated = true;
        killGroup("SIGKILL");
      }, cancelOn.graceMs),
    );
  };

  const handleLine = (line: string) => {
    const event = parseStreamLine(line);
    if (event === undefined) {
      if (line.trim() !== "") unparsed += 1;
      return;
    }
    events.push(event);
    const cancelOn = options.cancelOn;
    if (
      !closed &&
      cancelOn !== undefined &&
      !cancelScheduled &&
      event.type === cancelOn.eventType
    ) {
      cancelScheduled = true;
      timers.push(setTimeout(sendCancel, cancelOn.delayMs));
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 8 * 1024 * 1024) {
      outputLimitExceeded = true;
      killGroup("SIGKILL");
      return;
    }
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      handleLine(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Bounded: diagnostics only, never the full stream.
    stderr += chunk.slice(0, Math.max(0, 64_000 - stderr.length));
  });

  timers.push(
    setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
    }, options.timeoutMs),
  );

  return new Promise((resolvePromise, rejectPromise) => {
    child.on("error", (error) => {
      for (const timer of timers) clearTimeout(timer);
      rejectPromise(new Error(`codex spawn failed: ${error.name}`));
    });
    child.on("close", (exitCode, signal) => {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      if (stdoutBuffer !== "") handleLine(stdoutBuffer);
      const groupAliveAtClose = isGroupAlive(child.pid);
      // Leftover members of the group (none expected) must not outlive the test.
      killGroup("SIGKILL");
      const ended = Date.now();
      const run: CliRun = {
        exitCode,
        signal,
        durationMs: ended - started,
        events,
        unparsedStdoutLines: unparsed,
        stderr: redactText(stderr),
        groupAliveAtClose,
        timedOut,
        outputLimitExceeded,
      };
      if (options.cancelOn !== undefined && cancelSentAt !== undefined) {
        run.cancel = {
          signal: options.cancelOn.signal,
          afterMs: cancelSentAt - started,
          exitAfterSignalMs: ended - cancelSentAt,
          escalated,
        };
      }
      resolvePromise(run);
    });
  });
}

function isGroupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Secrets are scrubbed before diagnostics leave the helper; evidence also drops message bodies. */
export function redactText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(
      /((?:access_token|refresh_token|id_token|OPENAI_API_KEY|CODEX_API_KEY)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[REDACTED_TOKEN]");
}

const EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);
/** Unknown event names are data too: never echo them into evidence. */
export function summarizeEvent(event: StreamEvent): { type: string } {
  return { type: EVENT_TYPES.has(event.type) ? event.type : "unknown" };
}

export function classify(run: CliRun): "success" | "error" | "cancelled" {
  if (
    run.timedOut ||
    run.outputLimitExceeded ||
    run.groupAliveAtClose ||
    run.unparsedStdoutLines > 0
  )
    return "error";
  const failed = run.events.some((e) => e.type === "turn.failed" || e.type === "error");
  const complete = run.events.some((e) => e.type === "turn.completed");
  const success = run.exitCode === 0 && run.signal === null && complete && !failed;
  if (run.cancel !== undefined && !success) return "cancelled";
  return success ? "success" : "error";
}

/** Diagnostic categories only: never copy arbitrary stderr text into saved evidence. */
export function diagnosticCategory(stderr: string): string {
  if (/read-only file system|os error 30/i.test(stderr)) return "read-only-filesystem";
  if (/permission denied|operation not permitted/i.test(stderr)) return "permission-denied";
  if (/schema/i.test(stderr) && /invalid|pars(?:e|ing)|expected|failed|error/i.test(stderr))
    return "invalid-schema";
  if (/network|dns|connection|resolve host/i.test(stderr)) return "network";
  return stderr.trim() === "" ? "none" : "other";
}
