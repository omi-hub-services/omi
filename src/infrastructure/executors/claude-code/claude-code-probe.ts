import type { ProbeResult } from "../../../application/contracts/agent-execution.js";
import { runCommand, type CommandOutcome } from "../../processes/run-command.js";
import { checkClaudeCodeVersion, SUPPORTED_CLAUDE_CODE_RANGE } from "./claude-code-version.js";

const PROBE_TIMEOUT_MS = 30_000;

export interface ClaudeProbeOptions {
  executable: string;
  /** Child environment, already carrying the profile's `CLAUDE_CONFIG_DIR`. */
  env: Readonly<Record<string, string>>;
  /** A directory that exists; the probe reads nothing from it. */
  cwd: string;
}

type ProbeFields = Omit<ProbeResult, "executor" | "supportedRange">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= 64 ? value : undefined;
}

/**
 * Reads `claude auth status --json`. Only allowlisted fields are kept: never `email`, `orgId`
 * or `orgName` (ADR-0013). The command spends no model quota. The exit code is not trusted; a
 * logged-out CLI may exit non-zero with a JSON body, so the body decides.
 */
export function interpretAuthStatus(stdout: string): {
  status: "ready" | "login-required" | "unsupported-auth-mode" | "unavailable";
  subscriptionType?: string;
  loginExpiresAt?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: "unavailable" };
  }
  if (!isRecord(parsed) || typeof parsed["loggedIn"] !== "boolean") {
    return { status: "unavailable" };
  }
  if (!parsed["loggedIn"]) return { status: "login-required" };
  const subscriptionType = shortText(parsed["subscriptionType"]);
  const loginExpiresAt = shortText(parsed["loginExpiresAt"]);
  const extra = {
    ...(subscriptionType === undefined ? {} : { subscriptionType }),
    ...(loginExpiresAt === undefined ? {} : { loginExpiresAt }),
  };
  // Subscription mode only: an API key or a third-party provider is not the omi-squad path.
  if (parsed["authMethod"] !== "claude.ai" || parsed["apiProvider"] !== "firstParty") {
    return { status: "unsupported-auth-mode", ...extra };
  }
  return { status: "ready", ...extra };
}

function failed(outcome: CommandOutcome): boolean {
  return outcome.kind === "spawn-failed" || outcome.exit.timedOut;
}

/** Version first (cheap, decides whether the rest can be trusted), then login mode. */
export async function probeClaudeCode(options: ClaudeProbeOptions): Promise<ProbeFields> {
  const base = { executable: options.executable, cwd: options.cwd, env: options.env };
  const versionRun = await runCommand({
    ...base,
    args: ["--version"],
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (failed(versionRun) || versionRun.kind !== "finished" || versionRun.exit.exitCode !== 0) {
    return {
      status: "unavailable",
      compatibility: "unknown",
      diagnostic:
        versionRun.kind === "spawn-failed"
          ? "claude executable not found or not runnable; install claude, then run omi install --apply (or update --apply) from a WSL shell where claude is on PATH and restart the session"
          : "claude --version did not run successfully; check the CLI and rerun omi install --apply (or update --apply) from a working WSL shell, then restart the session",
    };
  }
  const { version, compatibility } = checkClaudeCodeVersion(versionRun.stdout);
  const versionFields = version === undefined ? {} : { version };
  if (compatibility !== "supported") {
    return {
      status: "unsupported-version",
      compatibility,
      ...versionFields,
      diagnostic:
        compatibility === "unknown"
          ? "claude --version output was not recognised"
          : `version is outside the supported range ${SUPPORTED_CLAUDE_CODE_RANGE.description}`,
    };
  }

  const authRun = await runCommand({
    ...base,
    args: ["auth", "status", "--json"],
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (failed(authRun) || authRun.kind !== "finished") {
    return {
      status: "unavailable",
      compatibility,
      ...versionFields,
      diagnostic: "claude auth status did not run",
    };
  }
  const auth = interpretAuthStatus(authRun.stdout);
  const { status, ...rest } = auth;
  const diagnostics: Record<typeof status, string | undefined> = {
    ready: undefined,
    "login-required": "profile is not logged in",
    "unsupported-auth-mode": "profile login is not a subscription (claude.ai) login",
    unavailable: "claude auth status output was not recognised",
  };
  const diagnostic = diagnostics[status];
  return {
    status,
    compatibility,
    ...versionFields,
    ...rest,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}
