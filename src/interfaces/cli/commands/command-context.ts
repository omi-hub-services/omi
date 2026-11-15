import type { SendCommand } from "../../ipc/ipc-client.js";
import { EXIT_CODES } from "../presenters/exit-codes.js";
import type { ExitCode } from "../presenters/exit-codes.js";
import type { OutputFormat, Presented } from "../presenters/result-presenter.js";

/** Options every command accepts; Commander parses them on the root program. */
export type GlobalOptions = { json?: boolean; socket?: string };

export function formatOf(options: GlobalOptions): OutputFormat {
  return options.json === true ? "json" : "text";
}

/** Everything a command handler may touch. Handlers hold no state of their own. */
export interface CliContext {
  readonly readText?: ((path: string) => Promise<string | undefined>) | undefined;
  readonly sendCommand: SendCommand;
  readonly defaultSocketPath: string;
  readonly timeoutMs: number;
  /** All of stdin as UTF-8 text; `undefined` when it is invalid or too large. */
  readonly readStdin?: (() => Promise<string | undefined>) | undefined;
  /** Writes the presented output and records the exit code the process should end with. */
  emit(presented: Presented): void;
}

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Collects what one CLI run printed and the exit code it ends with (the first non-zero wins). */
export function createCliContext(
  parts: Pick<
    CliContext,
    "sendCommand" | "defaultSocketPath" | "timeoutMs" | "readStdin" | "readText"
  >,
  output: CliOutput,
): { context: CliContext; exitCode: () => ExitCode } {
  let exitCode: ExitCode = EXIT_CODES.OK;
  return {
    context: {
      ...parts,
      emit(presented) {
        if (presented.stdout !== "") output.stdout(presented.stdout);
        if (presented.stderr !== "") output.stderr(presented.stderr);
        if (exitCode === EXIT_CODES.OK) exitCode = presented.exitCode;
      },
    },
    exitCode: () => exitCode,
  };
}
