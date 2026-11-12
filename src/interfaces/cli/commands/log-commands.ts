import type { Command } from "commander";
import { identifierSchema } from "../../../application/contracts/identifiers.js";
import type { retainWorkerLogs } from "../../../application/use-cases/runs/retain-worker-logs.js";
import { EXIT_CODES } from "../presenters/exit-codes.js";
import { presentLogRetention } from "../presenters/log-presenter.js";
import { presentFailure, presentUsageError } from "../presenters/result-presenter.js";
import { formatOf } from "./command-context.js";
import type { CliContext, GlobalOptions } from "./command-context.js";

/** Bootstrap binds this to the project's log directory and config; the CLI parses and presents. */
export interface LogCommands {
  pruneLogs(input: {
    projectDir: string;
    doneTasks: string[];
    dryRun: boolean;
  }): ReturnType<typeof retainWorkerLogs>;
}

export function registerLogCommands(
  program: Command,
  context: CliContext,
  actions?: LogCommands,
): void {
  program
    .command("prune-logs")
    .description(
      "Archive the worker logs of Done tasks and cap archive/ (also runs after task close)",
    )
    .requiredOption("--project <path>", "absolute Linux project path")
    .option("--task <id...>", "Done task id whose logs may be archived (repeatable)")
    .option("--dry-run", "show the plan and change nothing")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        GlobalOptions & { project: string; task?: string[]; dryRun?: boolean }
      >();
      const format = formatOf(options);
      const doneTasks = options.task ?? [];
      if (!doneTasks.every((id) => identifierSchema.safeParse(id).success)) {
        context.emit(presentUsageError("--task must be a task id", format));
        return;
      }
      try {
        if (actions === undefined) throw new Error("LOGS_NOT_WIRED");
        const result = await actions.pruneLogs({
          projectDir: options.project,
          doneTasks,
          dryRun: options.dryRun ?? false,
        });
        context.emit(presentLogRetention(result, format));
      } catch (error) {
        context.emit(
          presentFailure(
            {
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : "LOG_COMMAND_FAILED",
            },
            format,
            EXIT_CODES.FAILURE,
          ),
        );
      }
    });
}
