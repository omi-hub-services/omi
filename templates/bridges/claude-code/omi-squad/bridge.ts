// omi-squad Coordinator bridge (Windows side, ADR-0012). Calls the `omi` CLI inside WSL2:
//
//   wsl.exe -d <distribution> --cd <repository> --exec <shim> --json <typed args...>
//
// `--exec` runs the shim without the distro's shell, so nothing is re-expanded there. Windows
// still hands wsl.exe one command-line string, so every argument is quoted by
// `quoteWindowsCommandLine` and tested for round-trip. Free text (a pause reason) goes over
// stdin, never on the command line. The answer is the CLI's versioned JSON document.
//
// Self-contained on purpose (Node built-ins only, erasable TypeScript): it is copied into the
// project's Coordinator skill folder and runs with `node bridge.ts` on Windows. It holds no
// orchestration logic; every decision is made by the CLI and the runtime behind it.
//
//   node bridge.ts --config bridge.config.json --request request.json
//   node bridge.ts --config bridge.config.json --request -        (request JSON on stdin)

import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";

/** The one place the project-local shim is named; the installer (OMI-045) writes this file. */
export interface BridgeConfig {
  readonly distribution: string;
  /** Absolute project path inside the distro; becomes `--cd`. */
  readonly repository: string;
  /** Absolute path of the CLI shim inside the distro; becomes `--exec`. */
  readonly shim: string;
  /** Windows executable; defaults to `wsl.exe`. */
  readonly wsl?: string;
}

export type BridgeRequest =
  | { readonly command: "status"; readonly runId?: string }
  | { readonly command: "plan"; readonly issueNumber: number; readonly workflowId?: string }
  | { readonly command: "dispatch"; readonly runId: string; readonly stepId: string }
  | { readonly command: "wait"; readonly runId: string; readonly timeoutSeconds: number }
  | { readonly command: "pause"; readonly runId: string; readonly reason: string }
  | { readonly command: "resume"; readonly runId: string }
  | {
      readonly command: "deliver";
      readonly runId: string;
      readonly prNumber: number;
      readonly reviewedHeadSha: string;
      readonly requiredChecks: readonly string[];
      readonly minimumNativeApprovals?: number;
    }
  | { readonly command: "handoff"; readonly reason: "new-session" }
  | {
      readonly command: "handoff";
      readonly reason: "profile-switch";
      readonly toProfile: string;
    };

export type BridgeFailureKind =
  | "invalid-request"
  | "transport"
  | "failure"
  | "usage"
  | "runtime-unavailable"
  | "refused"
  | "protocol";

export type BridgeOutcome =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly kind: BridgeFailureKind;
      /** Exit code of the CLI, or `null` when no CLI ran or answered. */
      readonly exitCode: number | null;
      readonly code: string;
      readonly message: string;
    };

export class BridgeInputError extends Error {
  override readonly name = "BridgeInputError";
}

/** The CLI's `--json` document version this bridge understands. */
const CLI_SCHEMA_VERSION = 1;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_STDIN_BYTES = 65_536;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const DISTRIBUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function hasControlCharacter(value: string, allowLineBreaks: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (allowLineBreaks && (code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

function fail(message: string): never {
  throw new BridgeInputError(message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(object: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(`${what}: unknown field "${key}"`);
  }
}

function pattern(object: Record<string, unknown>, key: string, regex: RegExp): string {
  const value = object[key];
  if (typeof value !== "string" || !regex.test(value)) return fail(`"${key}" is invalid`);
  return value;
}

function optionalPattern(
  object: Record<string, unknown>,
  key: string,
  regex: RegExp,
): string | undefined {
  return object[key] === undefined ? undefined : pattern(object, key, regex);
}

function integer(object: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fail(`"${key}" must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

function absolutePosixPath(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 4096 ||
    hasControlCharacter(value, false)
  ) {
    return fail(`"${key}" must be an absolute path inside the distribution`);
  }
  return value;
}

export function parseConfig(raw: unknown): BridgeConfig {
  const object = record(raw, "bridge config");
  onlyKeys(object, ["distribution", "repository", "shim", "wsl"], "bridge config");
  const wsl = object["wsl"];
  if (
    wsl !== undefined &&
    (typeof wsl !== "string" || wsl === "" || hasControlCharacter(wsl, false))
  ) {
    fail('"wsl" must be an executable name or path');
  }
  return {
    distribution: pattern(object, "distribution", DISTRIBUTION),
    repository: absolutePosixPath(object, "repository"),
    shim: absolutePosixPath(object, "shim"),
    ...(typeof wsl === "string" ? { wsl } : {}),
  };
}

export function parseRequest(raw: unknown): BridgeRequest {
  const object = record(raw, "request");
  const command = object["command"];
  switch (command) {
    case "status": {
      onlyKeys(object, ["command", "runId"], "status");
      const runId = optionalPattern(object, "runId", IDENTIFIER);
      return runId === undefined ? { command } : { command, runId };
    }
    case "plan": {
      onlyKeys(object, ["command", "issueNumber", "workflowId"], "plan");
      const workflowId = optionalPattern(object, "workflowId", SLUG);
      const issueNumber = integer(object, "issueNumber", 1, 999_999_999);
      return workflowId === undefined
        ? { command, issueNumber }
        : { command, issueNumber, workflowId };
    }
    case "dispatch":
      onlyKeys(object, ["command", "runId", "stepId"], "dispatch");
      return {
        command,
        runId: pattern(object, "runId", IDENTIFIER),
        stepId: pattern(object, "stepId", SLUG),
      };
    case "wait":
      onlyKeys(object, ["command", "runId", "timeoutSeconds"], "wait");
      return {
        command,
        runId: pattern(object, "runId", IDENTIFIER),
        timeoutSeconds: integer(object, "timeoutSeconds", 1, 3600),
      };
    case "pause": {
      onlyKeys(object, ["command", "runId", "reason"], "pause");
      const reason = object["reason"];
      if (
        typeof reason !== "string" ||
        reason.trim() === "" ||
        reason.trim().length > 500 ||
        hasControlCharacter(reason, true) ||
        Buffer.byteLength(reason, "utf8") > MAX_STDIN_BYTES
      ) {
        return fail('"reason" must be 1-500 characters of text');
      }
      return { command, runId: pattern(object, "runId", IDENTIFIER), reason: reason.trim() };
    }
    case "resume":
      onlyKeys(object, ["command", "runId"], "resume");
      return { command, runId: pattern(object, "runId", IDENTIFIER) };
    case "deliver": {
      onlyKeys(
        object,
        [
          "command",
          "runId",
          "prNumber",
          "reviewedHeadSha",
          "requiredChecks",
          "minimumNativeApprovals",
        ],
        "deliver",
      );
      const checks = object["requiredChecks"];
      if (!Array.isArray(checks) || checks.length < 1 || checks.length > 50) {
        return fail('"requiredChecks" must list 1-50 check names');
      }
      const requiredChecks = checks.map((check: unknown): string => {
        if (
          typeof check !== "string" ||
          check.trim() === "" ||
          check.trim().length > 200 ||
          hasControlCharacter(check, false)
        ) {
          return fail('"requiredChecks" has an invalid check name');
        }
        return check.trim();
      });
      const base = {
        command,
        runId: pattern(object, "runId", IDENTIFIER),
        prNumber: integer(object, "prNumber", 1, 999_999_999),
        reviewedHeadSha: pattern(object, "reviewedHeadSha", GIT_SHA),
        requiredChecks,
      } as const;
      return object["minimumNativeApprovals"] === undefined
        ? base
        : { ...base, minimumNativeApprovals: integer(object, "minimumNativeApprovals", 0, 10) };
    }
    case "handoff": {
      const reason = object["reason"];
      if (reason === "new-session") {
        onlyKeys(object, ["command", "reason"], "handoff");
        return { command, reason };
      }
      if (reason === "profile-switch") {
        onlyKeys(object, ["command", "reason", "toProfile"], "handoff");
        return { command, reason, toProfile: pattern(object, "toProfile", SLUG) };
      }
      return fail('"reason" must be "new-session" or "profile-switch"');
    }
    default:
      return fail("unknown command");
  }
}

/**
 * The CLI argument vector for a request, plus any text that must travel on stdin. Every value is
 * attached with `--flag=value` so a value that starts with `-` (a check name, say) is never read
 * as an option. Nothing here is ever joined into a shell string.
 */
export function buildCliArgv(request: BridgeRequest): {
  readonly args: readonly string[];
  readonly stdin?: string;
} {
  const json = "--json";
  switch (request.command) {
    case "status":
      return {
        args: [json, "status", ...(request.runId === undefined ? [] : [`--run=${request.runId}`])],
      };
    case "plan":
      return {
        args: [
          json,
          "plan",
          `--issue=${String(request.issueNumber)}`,
          ...(request.workflowId === undefined ? [] : [`--workflow=${request.workflowId}`]),
        ],
      };
    case "dispatch":
      return {
        args: [json, "dispatch", `--run=${request.runId}`, `--step=${request.stepId}`],
      };
    case "wait":
      return {
        args: [
          json,
          "wait",
          `--run=${request.runId}`,
          `--timeout=${String(request.timeoutSeconds)}`,
        ],
      };
    case "pause":
      return {
        args: [json, "pause", `--run=${request.runId}`, "--reason-stdin"],
        stdin: request.reason,
      };
    case "resume":
      return { args: [json, "resume", `--run=${request.runId}`] };
    case "deliver":
      return {
        args: [
          json,
          "deliver",
          `--run=${request.runId}`,
          `--pr=${String(request.prNumber)}`,
          `--head-sha=${request.reviewedHeadSha}`,
          ...request.requiredChecks.map((check) => `--check=${check}`),
          ...(request.minimumNativeApprovals === undefined
            ? []
            : [`--min-approvals=${String(request.minimumNativeApprovals)}`]),
        ],
      };
    case "handoff":
      return request.reason === "new-session"
        ? { args: [json, "session", "new"] }
        : { args: [json, "coordinator", "switch", `--to=${request.toProfile}`] };
  }
}

/** The arguments of `wsl.exe` for one CLI call. No shell is involved on the Linux side. */
export function buildWslArgs(config: BridgeConfig, cliArgs: readonly string[]): readonly string[] {
  return ["-d", config.distribution, "--cd", config.repository, "--exec", config.shim, ...cliArgs];
}

/**
 * One Windows command-line string for `args`, quoted so the standard parser
 * (`CommandLineToArgvW`, the C runtime) returns exactly `args`. Every argument is quoted:
 * backslashes are doubled only before a quote, and a quote becomes `\"`.
 */
export function quoteWindowsCommandLine(args: readonly string[]): string {
  return args
    .map((arg) => {
      let quoted = '"';
      let backslashes = 0;
      for (const char of arg) {
        if (char === "\\") {
          backslashes += 1;
        } else if (char === '"') {
          quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
          backslashes = 0;
        } else {
          quoted += `${"\\".repeat(backslashes)}${char}`;
          backslashes = 0;
        }
      }
      return `${quoted}${"\\".repeat(backslashes * 2)}"`;
    })
    .join(" ");
}

const FAILURE_BY_EXIT_CODE: Readonly<Record<number, BridgeFailureKind>> = {
  1: "failure",
  2: "usage",
  3: "runtime-unavailable",
  4: "refused",
  5: "protocol",
};

function printable(text: string, limit: number): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 32 || (code >= 127 && code <= 159) ? " " : char;
    if (out.length >= limit) break;
  }
  return out.trim();
}

/** wsl.exe writes its own messages as UTF-16LE; decode them only to describe a transport error. */
function describeNonJson(stdout: Uint8Array, stderr: Uint8Array): string {
  const pick = stdout.byteLength > 0 ? stdout : stderr;
  const utf16 = pick.includes(0);
  const text = new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(pick);
  return printable(text, 300);
}

/**
 * Reads the CLI's answer. The `--json` document on stdout is authoritative; a document that
 * disagrees with the process exit code, or any other output, is a protocol or transport failure
 * and never reads as success.
 */
export function parseCliOutput(
  stdout: Uint8Array,
  stderr: Uint8Array,
  exitCode: number | null,
): BridgeOutcome {
  const transport = (message: string): BridgeOutcome => ({
    ok: false,
    kind: "transport",
    exitCode,
    code: "TRANSPORT_ERROR",
    message,
  });
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)) as unknown;
  } catch {
    const detail = describeNonJson(stdout, stderr);
    return transport(
      `the CLI did not answer with JSON (exit ${exitCode === null ? "none" : String(exitCode)})${
        detail === "" ? "" : `: ${detail}`
      }`,
    );
  }
  const protocol = (message: string): BridgeOutcome => ({
    ok: false,
    kind: "protocol",
    exitCode,
    code: "PROTOCOL_ERROR",
    message,
  });
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return protocol("the CLI answer is not a JSON object");
  }
  const body = document as Record<string, unknown>;
  if (body["schemaVersion"] !== CLI_SCHEMA_VERSION) {
    return protocol("the CLI answer has an unsupported schemaVersion");
  }
  if (typeof body["ok"] !== "boolean" || body["exitCode"] !== exitCode) {
    return protocol("the CLI answer disagrees with its exit code");
  }
  if (body["ok"]) {
    return exitCode === 0 && "result" in body
      ? { ok: true, result: body["result"] }
      : protocol("the CLI answer is malformed");
  }
  const error = body["error"];
  const detail =
    typeof error === "object" && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  const code = detail?.["code"];
  const message = detail?.["message"];
  if (
    typeof code !== "string" ||
    typeof message !== "string" ||
    exitCode === null ||
    exitCode === 0
  ) {
    return protocol("the CLI failure answer is malformed");
  }
  return {
    ok: false,
    kind: FAILURE_BY_EXIT_CODE[exitCode] ?? "failure",
    exitCode,
    code: printable(code, 64),
    message: printable(message, 1000),
  };
}

export type BridgeSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ReturnType<typeof spawn>;

export interface CallOptions {
  readonly spawn?: BridgeSpawn;
  /** Defaults to `process.platform`; Windows passes one pre-quoted command line. */
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

function defaultTimeoutMs(request: BridgeRequest): number {
  return request.command === "wait" ? (request.timeoutSeconds + 30) * 1000 : 150_000;
}

/** Calls the CLI once and returns its outcome. Never throws for a CLI or transport failure. */
export function callCli(
  config: BridgeConfig,
  request: BridgeRequest,
  options: CallOptions = {},
): Promise<BridgeOutcome> {
  const launch = options.spawn ?? spawn;
  const { args, stdin } = buildCliArgv(request);
  const wslArgs = buildWslArgs(config, args);
  const windows = (options.platform ?? process.platform) === "win32";
  const executable = config.wsl ?? "wsl.exe";
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs(request);
  return new Promise((resolve) => {
    const child = launch(executable, windows ? [quoteWindowsCommandLine(wslArgs)] : wslArgs, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: windows,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let outSize = 0;
    let overflow = false;
    let settled = false;
    const finish = (outcome: BridgeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        kind: "transport",
        exitCode: null,
        code: "TIMEOUT",
        message: `no answer from the CLI within ${String(Math.round(timeoutMs / 1000))} seconds`,
      });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Uint8Array) => {
      outSize += chunk.byteLength;
      if (outSize > MAX_OUTPUT_BYTES) overflow = true;
      else out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", () => {
      finish({
        ok: false,
        kind: "transport",
        exitCode: null,
        code: "SPAWN_FAILED",
        message: `could not start ${printable(executable, 100)}`,
      });
    });
    child.on("close", (code: number | null) => {
      finish(
        overflow
          ? {
              ok: false,
              kind: "transport",
              exitCode: code,
              code: "OUTPUT_TOO_LARGE",
              message: "the CLI answer is larger than the bridge accepts",
            }
          : parseCliOutput(Buffer.concat(out), Buffer.concat(err), code),
      );
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin === undefined ? undefined : stdin);
  });
}

function readBounded(path: string): string {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_STDIN_BYTES) fail("input file is too large");
  return text;
}

function readStdinText(): string {
  const text = readFileSync(0, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_STDIN_BYTES) fail("request is too large");
  return text;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** `node bridge.ts --config <file> --request <file|->`; prints one JSON document. */
export async function main(argv: readonly string[]): Promise<number> {
  let outcome: BridgeOutcome;
  try {
    const configPath = flag(argv, "--config");
    const requestPath = flag(argv, "--request");
    if (configPath === undefined || requestPath === undefined) {
      fail("usage: node bridge.ts --config <file> --request <file|->");
    }
    const config = parseConfig(JSON.parse(readBounded(configPath)) as unknown);
    const request = parseRequest(
      JSON.parse(requestPath === "-" ? readStdinText() : readBounded(requestPath)) as unknown,
    );
    outcome = await callCli(config, request);
  } catch (error) {
    outcome = {
      ok: false,
      kind: "invalid-request",
      exitCode: null,
      code: "INVALID_REQUEST",
      message: error instanceof BridgeInputError ? error.message : "could not read the input",
    };
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  return outcome.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
