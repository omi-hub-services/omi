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

const JWT_PATTERN = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const CREDENTIAL_KEY_PART =
  /token|password|passwd|secret|api[_-]?key|private[_-]?key|credential|authorization|cookie/i;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const FIXED_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const CONFIG_FIXED_CODES = new Set(["INVALID_MODELS_CONFIG", "PROJECT_NOT_CONFIGURED"]);

function redact(text: string): string {
  return (
    [...SECRET_PATTERNS, JWT_PATTERN]
      .reduce((acc, pattern) => acc.replace(pattern, "[redacted]"), text)
      // Quoted fragments are interpolated user values (model aliases, keys, step ids): never echo them.
      .replace(/(["'`])(?:(?!\1).)*\1/g, "$1[redacted]$1")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 300)
  );
}

/** Path segments can be user-chosen map keys, so only plain, non-credential-shaped names pass. */
function redactSegment(segment: string): string {
  return SAFE_PATH_SEGMENT.test(segment) &&
    !CREDENTIAL_KEY_PART.test(segment) &&
    redact(segment) === segment
    ? segment
    : "[redacted]";
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
        (issue) =>
          `  ${issue.path.map((part) => redactSegment(String(part))).join(".") || "(root)"}: ${redact(issue.message)}`,
      );
    return head("CONFIG_INVALID", "") + lines.join("\n") + "\n";
  }
  if (error instanceof ProjectInitializationError || error instanceof CredentialInputError)
    return head("CONFIG_INVALID", error.code);
  if (error instanceof GitWorkspaceError) return head("GIT_WORKSPACE_FAILED", error.code);
  if (error instanceof RuntimeStartupError) return head(error.code, redact(error.message));
  // Its message embeds the cause's message, so only the class is reported.
  if (error instanceof Error && error.name === "CatalogLoadError")
    return head("CONFIG_INVALID", "");
  if (hasErrnoCode(error)) return head("PATH_ERROR", error.code);
  if (error instanceof Error && FIXED_CODE.test(error.message))
    return head(
      CONFIG_FIXED_CODES.has(error.message) ? "CONFIG_INVALID" : "RUNTIME_STARTUP_FAILED",
      error.message,
    );
  return head("RUNTIME_STARTUP_FAILED", "");
}
