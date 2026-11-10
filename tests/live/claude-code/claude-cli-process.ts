// OMI-002 PoC support: spawn the Claude Code CLI in print mode and parse its stream-json output.
// This is test-only code. The production adapter is OMI-013 under
// src/infrastructure/executors/claude-code/ and must not import from here.
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
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * Builds the child environment from an allowlist, so API keys, OAuth tokens and the parent
 * Claude Code session variables (CLAUDECODE, CLAUDE_CODE_*) never leak into the worker.
 */
export function buildWorkerEnv(
  parent: NodeJS.ProcessEnv,
  claudeConfigDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  env["CLAUDE_CONFIG_DIR"] = claudeConfigDir;
  // Keep the CLI version fixed for the duration of a run.
  env["DISABLE_AUTOUPDATER"] = "1";
  return env;
}

export type StreamEvent = Record<string, unknown> & { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one stream-json line; returns undefined for non-JSON or untyped lines. */
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
  /** Send `signal` `delayMs` after the first `eventType` event; SIGKILL the group after `graceMs`. */
  cancelOn?: { eventType: string; delayMs: number; signal: NodeJS.Signals; graceMs: number };
}

export function runClaude(options: CliRunOptions): Promise<CliRun> {
  const started = Date.now();
  // detached: the child leads its own process group, so a terminal Ctrl-C does not reach it and
  // the group can be killed as a last resort without touching unrelated Claude sessions.
  const child = spawn("claude", options.args, {
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
    if (cancelOn === undefined) return;
    cancelSentAt = Date.now();
    child.kill(cancelOn.signal);
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
    if (cancelOn !== undefined && !cancelScheduled && event.type === cancelOn.eventType) {
      cancelScheduled = true;
      timers.push(setTimeout(sendCancel, cancelOn.delayMs));
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
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
    if (stderr.length < 64_000) stderr += chunk;
  });

  timers.push(
    setTimeout(() => {
      escalated = true;
      killGroup("SIGKILL");
    }, options.timeoutMs),
  );

  return new Promise((resolvePromise, rejectPromise) => {
    child.on("error", (error) => {
      for (const timer of timers) clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (exitCode, signal) => {
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
        stderr,
        groupAliveAtClose,
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

export function findEvent(run: CliRun, type: string, subtype?: string): StreamEvent | undefined {
  return run.events.find(
    (event) => event.type === type && (subtype === undefined || event["subtype"] === subtype),
  );
}

/** Names of tools the model actually called, from assistant tool_use content blocks. */
export function toolUseNames(run: CliRun): string[] {
  const names: string[] = [];
  for (const event of run.events) {
    if (event.type !== "assistant") continue;
    const message = event["message"];
    if (!isRecord(message) || !Array.isArray(message["content"])) continue;
    for (const block of message["content"] as unknown[]) {
      if (isRecord(block) && block["type"] === "tool_use" && typeof block["name"] === "string") {
        names.push(block["name"]);
      }
    }
  }
  return names;
}

export function stringField(event: StreamEvent | undefined, name: string): string | undefined {
  const value = event?.[name];
  return typeof value === "string" ? value : undefined;
}

export function stringArrayField(event: StreamEvent | undefined, name: string): string[] {
  const value = event?.[name];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * Best-effort text redaction for evidence files. Regexes cannot catch every secret
 * (tech-stack.md §9), so evidence also keeps only allowlisted fields.
 */
export function redactText(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[REDACTED_LONG_TOKEN]");
}

/** One redacted log line per event: type, subtype and tool names, never message bodies. */
export function summarizeEvent(event: StreamEvent): Record<string, unknown> {
  const line: Record<string, unknown> = { type: event.type };
  if (typeof event["subtype"] === "string") line["subtype"] = event["subtype"];
  if (event.type === "assistant") {
    const tools = toolUseNames({
      events: [event],
      exitCode: null,
      signal: null,
      durationMs: 0,
      unparsedStdoutLines: 0,
      stderr: "",
      groupAliveAtClose: false,
    });
    if (tools.length > 0) line["toolUse"] = tools;
  }
  if (event.type === "result") {
    for (const key of ["is_error", "num_turns", "duration_ms", "stop_reason"] as const) {
      if (event[key] !== undefined) line[key] = event[key];
    }
  }
  return line;
}
