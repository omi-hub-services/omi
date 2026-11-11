import type { Command } from "commander";
import { sessionLaunchSchema } from "../../../application/contracts/session-launch.js";
import type { SessionLauncher } from "../../../application/ports/session-launcher.js";
import {
  presentSuccess,
  presentFailure,
  presentUsageError,
} from "../presenters/result-presenter.js";
import { EXIT_CODES } from "../presenters/exit-codes.js";
import { formatOf, type CliContext, type GlobalOptions } from "./command-context.js";

/** Start is local bootstrap: there is no IPC server to send a start command to yet. */
export function registerSessionCommands(
  program: Command,
  context: CliContext,
  launch?: SessionLauncher,
): void {
  program
    .command("session")
    .description("Managed foreground session (Ctrl-C to stop)")
    .command("start")
    .requiredOption("--project <wsl-path>", "absolute project path in WSL")
    .requiredOption("--runtime <wsl-path>", "absolute compiled runtime.js path in WSL")
    .option("--distribution <name>", "WSL distribution")
    .option("--coordinator <executable>", "Windows Coordinator executable", "claude")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        GlobalOptions & {
          project: string;
          runtime: string;
          distribution?: string;
          coordinator: string;
        }
      >();
      const format = formatOf(options);
      const input = sessionLaunchSchema.safeParse({
        projectDir: options.project,
        runtimePath: options.runtime,
        coordinator: options.coordinator,
        ...(options.distribution === undefined ? {} : { distribution: options.distribution }),
      });
      if (!input.success) {
        context.emit(
          presentUsageError(
            "session requires absolute WSL paths and a valid distribution/executable",
            format,
          ),
        );
        return;
      }
      if (options.socket !== undefined) {
        context.emit(presentUsageError("session start uses the project's default socket", format));
        return;
      }
      if (launch === undefined) throw new Error("session launcher is not wired");
      const result = await launch(input.data);
      context.emit(
        result.exitCode === 0 && result.runtimeStopped
          ? presentSuccess(result, "Session stopped", format)
          : presentFailure(
              {
                code: "INTERNAL_ERROR",
                message: "session failed or runtime stop was not confirmed",
              },
              format,
              EXIT_CODES.FAILURE,
            ),
      );
    });
}
