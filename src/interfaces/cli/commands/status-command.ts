import type { Command } from "commander";
import { CONTRACT_SCHEMA_VERSION } from "../../../application/contracts/schema-version.js";
import { presentStatus } from "../presenters/status-presenter.js";
import { formatOf } from "./command-context.js";
import type { CliContext, GlobalOptions } from "./command-context.js";

/** `status`: asks the runtime over IPC what it reports. Parses, sends, presents; nothing else. */
export function registerStatusCommand(program: Command, context: CliContext): void {
  program
    .command("status")
    .description("Show whether the runtime is up and what it reports")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const outcome = await context.sendCommand({
        socketPath: options.socket ?? context.defaultSocketPath,
        command: { schemaVersion: CONTRACT_SCHEMA_VERSION, command: "status" },
        timeoutMs: context.timeoutMs,
      });
      context.emit(presentStatus(outcome, formatOf(options)));
    });
}
