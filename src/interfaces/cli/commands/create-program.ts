import type { SessionLauncher } from "../../../application/ports/session-launcher.js";
import { registerSessionCommands } from "./session-commands.js";
import { Command, CommanderError } from "commander";
import { EXIT_CODES } from "../presenters/exit-codes.js";
import type { ExitCode } from "../presenters/exit-codes.js";
import { presentFailure, presentUsageError } from "../presenters/result-presenter.js";
import { createCliContext, formatOf } from "./command-context.js";
import type { CliContext, CliOutput, GlobalOptions } from "./command-context.js";
import { registerApprovalCommands } from "./approval-commands.js";
import { registerRunCommands } from "./run-commands.js";
import { registerStatusCommand } from "./status-command.js";

export interface CliEnvironment extends CliOutput {
  readonly sendCommand: CliContext["sendCommand"];
  readonly defaultSocketPath: string;
  readonly timeoutMs: number;
  readonly version: string;
  readonly launchSession?: SessionLauncher;
  readonly readStdin?: CliContext["readStdin"] | undefined;
}

/** Builds the Commander program. Every command is registered here and nowhere else. */
export function createProgram(context: CliContext, environment: CliEnvironment): Command {
  const program = new Command("omi-squad")
    .version(environment.version)
    .description("omi-squad command line (IPC skeleton)")
    .option("--json", "print one machine-readable JSON document")
    .option("--socket <path>", "runtime socket path")
    // Throw instead of exiting, and print nothing of our own: runCli maps errors to exit codes.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        environment.stdout(text);
      },
      writeErr: (text) => {
        environment.stderr(text);
      },
      outputError: () => undefined,
    });
  registerStatusCommand(program, context);
  registerSessionCommands(program, context, environment.launchSession);
  registerApprovalCommands(program, context);
  registerRunCommands(program, context);
  return program;
}

/**
 * Runs one CLI invocation and returns the process exit code (see `EXIT_CODES`). It never throws
 * and never touches `process`, so the same function serves the executable and the tests.
 */
export async function runCli(
  argv: readonly string[],
  environment: CliEnvironment,
): Promise<ExitCode> {
  const { context, exitCode } = createCliContext(environment, environment);
  const program = createProgram(context, environment);
  // Usage errors happen before options are parsed, so look for --json directly.
  const format = formatOf({ json: argv.includes("--json") } satisfies GlobalOptions);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return EXIT_CODES.OK;
      }
      const message =
        error.code === "commander.help"
          ? "a command is required (try --help)"
          : error.message.replace(/^error: /, "");
      context.emit(presentUsageError(message, format));
    } else {
      context.emit(
        presentFailure(
          { code: "INTERNAL_ERROR", message: "unexpected failure in the CLI" },
          format,
          EXIT_CODES.FAILURE,
        ),
      );
    }
  }
  return exitCode();
}
