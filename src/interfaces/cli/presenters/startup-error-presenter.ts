import type { ZodError } from "zod";
import { GitWorkspaceError } from "../../../application/ports/git-workspace.js";
import { CredentialInputError } from "../../../application/contracts/credential-input.js";
import { ProjectInitializationError } from "../../../application/ports/github-project-reader.js";

export type StartupErrorCode =
  | "CONFIG_INVALID"
  | "GIT_WORKSPACE_FAILED"
  | "PATH_INVALID"
  | "PATH_ERROR"
  | "RUNTIME_STARTUP_FAILED";

/** A startup failure whose message is safe to print (fixed text, no file contents). */
export class RuntimeStartupError extends Error {
  override readonly name = "RuntimeStartupError";
  readonly code: "PATH_INVALID";
  constructor(code: "PATH_INVALID", message: string) {
    super(message);
    this.code = code;
  }
}

// shortcut: pattern list covers common token shapes only; extend when a new credential kind appears.
const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-)[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redacted]"), text)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
}

// Duck-typed: the error can come from a second zod copy under the TS loader, failing instanceof.
function isZodError(error: unknown): error is ZodError {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function hasErrnoCode(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z0-9]+$/.test(error.code)
  );
}

/** Classified, redacted stderr text for a failed runtime start. Never includes a stack. */
export function presentStartupError(error: unknown): string {
  const head = (code: StartupErrorCode, detail: string) =>
    `omi runtime startup failed [${code}]${detail === "" ? "" : `: ${detail}`}\n`;
  if (isZodError(error)) {
    const lines = error.issues
      .slice(0, 10)
      .map(
        (issue) => `  ${issue.path.map(String).join(".") || "(root)"}: ${redact(issue.message)}`,
      );
    return head("CONFIG_INVALID", "") + lines.join("\n") + "\n";
  }
  if (error instanceof ProjectInitializationError || error instanceof CredentialInputError)
    return head("CONFIG_INVALID", error.code);
  if (error instanceof GitWorkspaceError) return head("GIT_WORKSPACE_FAILED", error.code);
  if (error instanceof RuntimeStartupError) return head(error.code, redact(error.message));
  if (hasErrnoCode(error)) return head("PATH_ERROR", error.code);
  return head("RUNTIME_STARTUP_FAILED", "");
}
