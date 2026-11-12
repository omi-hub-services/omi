import { CONTRACT_SCHEMA_VERSION } from "../../../application/contracts/schema-version.js";
import type { IpcError } from "../../ipc/protocol.js";
import { EXIT_CODES, exitCodeForError } from "./exit-codes.js";
import type { ExitCode } from "./exit-codes.js";

export type OutputFormat = "text" | "json";

/** What the CLI prints and returns for one command. Presenters never touch the process. */
export interface Presented {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: ExitCode;
}

/** Error text may carry peer-supplied bytes; keep control characters off the terminal. */
function printable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : char;
  }
  return out;
}

/**
 * `--json` output is one stable document on stdout for success and failure alike:
 * `{ schemaVersion, ok, exitCode, result }` or `{ schemaVersion, ok, exitCode, error }`.
 * Error `code` values are the classification and never change meaning.
 */
export function presentSuccess(value: unknown, text: string, format: OutputFormat): Presented {
  if (format === "json") {
    const doc = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ok: true,
      exitCode: EXIT_CODES.OK,
      result: value,
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "", exitCode: EXIT_CODES.OK };
  }
  return { stdout: `${text}\n`, stderr: "", exitCode: EXIT_CODES.OK };
}

export function presentFailure(
  error: IpcError | { readonly code: "DOCTOR_FAILED"; readonly message: string },
  format: OutputFormat,
  exitCode: ExitCode = error.code === "DOCTOR_FAILED"
    ? EXIT_CODES.DOCTOR_FAILED
    : exitCodeForError(error.code),
): Presented {
  if (format === "json") {
    const doc = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ok: false,
      exitCode,
      error: { code: error.code, message: error.message },
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "", exitCode };
  }
  return { stdout: "", stderr: `error[${error.code}]: ${printable(error.message)}\n`, exitCode };
}

/** A usage error is the CLI's own: it has no IPC code, so it gets its own classification. */
export function presentUsageError(message: string, format: OutputFormat): Presented {
  if (format === "json") {
    const doc = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ok: false,
      exitCode: EXIT_CODES.USAGE,
      error: { code: "USAGE", message },
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "", exitCode: EXIT_CODES.USAGE };
  }
  return {
    stdout: "",
    stderr: `error[USAGE]: ${printable(message)}\n`,
    exitCode: EXIT_CODES.USAGE,
  };
}
