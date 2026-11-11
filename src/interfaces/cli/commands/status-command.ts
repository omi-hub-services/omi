import type { Command } from "commander";
import { commandSchema } from "../../../application/contracts/command.js";
import { CONTRACT_SCHEMA_VERSION } from "../../../application/contracts/schema-version.js";
import {
  presentFailure,
  presentSuccess,
  presentUsageError,
} from "../presenters/result-presenter.js";
import { presentStatus } from "../presenters/status-presenter.js";
import { formatOf } from "./command-context.js";
import type { CliContext, GlobalOptions } from "./command-context.js";

/** `status`: asks the runtime over IPC what it reports. Parses, sends, presents; nothing else. */
export function registerStatusCommand(program: Command, context: CliContext): void {
  program
    .command("status")
    .description("Show whether the runtime is up and what it reports, or one run's steps")
    .option("--run <id>", "report this run and its steps instead of the runtime")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions & { run?: string }>();
      const parsed = commandSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        command: "status",
        ...(options.run === undefined ? {} : { runId: options.run }),
      });
      if (!parsed.success) {
        context.emit(presentUsageError("invalid run id", formatOf(options)));
        return;
      }
      const outcome = await context.sendCommand({
        socketPath: options.socket ?? context.defaultSocketPath,
        command: parsed.data,
        timeoutMs: context.timeoutMs,
      });
      // A run's view has its own shape; only the runtime report goes through the status schema.
      context.emit(
        options.run === undefined
          ? presentStatus(outcome, formatOf(options))
          : outcome.ok
            ? presentSuccess(outcome.result, JSON.stringify(outcome.result), formatOf(options))
            : presentFailure(outcome.error, formatOf(options)),
      );
    });
}
