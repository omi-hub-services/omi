import type { IpcErrorCode } from "../../ipc/protocol.js";

/**
 * Process exit codes of the CLI. They are part of the contract with the Coordinator and PO
 * scripts (architecture.md §13): a value is never reused or renumbered, only added. Documented
 * in ADR-0020.
 *
 *   0  OK                   the command ran and the runtime accepted it
 *   1  FAILURE              unexpected failure inside the CLI itself, or INTERNAL_ERROR from runtime
 *   2  USAGE                bad arguments, unknown command or option (nothing was sent)
 *   3  RUNTIME_UNAVAILABLE  no runtime on the socket, or it did not answer in time
 *   4  REQUEST_REJECTED     the runtime understood the request and refused it with a typed error
 *                           (invalid command, unsupported version, too large, not implemented)
 *   5  PROTOCOL_ERROR       the runtime's answer was malformed or did not match the request
 *
 * 0 does not mean a task passed acceptance; it only says this command succeeded.
 */
export const EXIT_CODES = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  RUNTIME_UNAVAILABLE: 3,
  REQUEST_REJECTED: 4,
  PROTOCOL_ERROR: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Exhaustive on purpose: adding an IPC error code fails the build until it has an exit code. */
const EXIT_CODE_BY_IPC_ERROR: Record<IpcErrorCode, ExitCode> = {
  PAYLOAD_TOO_LARGE: EXIT_CODES.REQUEST_REJECTED,
  MALFORMED_REQUEST: EXIT_CODES.REQUEST_REJECTED,
  UNSUPPORTED_VERSION: EXIT_CODES.REQUEST_REJECTED,
  INVALID_COMMAND: EXIT_CODES.REQUEST_REJECTED,
  NOT_IMPLEMENTED: EXIT_CODES.REQUEST_REJECTED,
  INTERNAL_ERROR: EXIT_CODES.FAILURE,
  APPROVAL_REFUSED: EXIT_CODES.REQUEST_REJECTED,
  COMMAND_REFUSED: EXIT_CODES.REQUEST_REJECTED,
  RUNTIME_UNAVAILABLE: EXIT_CODES.RUNTIME_UNAVAILABLE,
  TIMEOUT: EXIT_CODES.RUNTIME_UNAVAILABLE,
  PROTOCOL_ERROR: EXIT_CODES.PROTOCOL_ERROR,
};

export function exitCodeForError(code: IpcErrorCode): ExitCode {
  return EXIT_CODE_BY_IPC_ERROR[code];
}
