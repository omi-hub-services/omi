import type { Command } from "commander";
import { CONTRACT_SCHEMA_VERSION } from "../../../application/contracts/schema-version.js";
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
  const session = program.command("session").description("Coordinator session");
  session
    .command("new")
    .description("End this Coordinator session cleanly: pause all runs so a new session can resume")
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const format = formatOf(globals);
      const outcome = await context.sendCommand({
        socketPath: globals.socket ?? context.defaultSocketPath,
        timeoutMs: Math.max(context.timeoutMs, 60_000),
        command: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          command: "handoff",
          reason: "new-session",
        },
      });
      context.emit(
        outcome.ok
          ? presentSuccess(outcome.result, JSON.stringify(outcome.result), format)
          : presentFailure(outcome.error, format),
      );
    });
  session
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
      const result = await launch(input.data).catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "RUNTIME_START_FAILED") throw error;
        return error;
      });
      if (result instanceof Error) {
        context.emit(
          presentFailure(
            {
              code: "RUNTIME_UNAVAILABLE",
              message:
                "RUNTIME_START_FAILED: the session runtime did not start in WSL or did not report ready in time. Run omi doctor (session-runtime-launch); if Node.js is missing, reinstall with omi install --apply using a working Node.js or configure node on PATH",
            },
            format,
            EXIT_CODES.FAILURE,
          ),
        );
        return;
      }
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
