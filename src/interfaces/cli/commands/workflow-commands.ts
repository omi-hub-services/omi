import type { Command } from "commander";
import type { WorkflowValidationResult } from "../../../application/contracts/workflow-validation.js";
import type { CliContext, GlobalOptions } from "./command-context.js";
import { presentUsageError } from "../presenters/result-presenter.js";
import { formatOf } from "./command-context.js";

export type WorkflowCommands = { validate(): Promise<WorkflowValidationResult> };

export function registerWorkflowCommands(
  program: Command,
  context: CliContext,
  workflows?: WorkflowCommands,
): void {
  program
    .command("workflows")
    .description("Installed workflow catalog")
    .command("validate")
    .description("validate workflows and referenced roles, rules and skills offline")
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      if (workflows === undefined) {
        context.emit(presentUsageError("workflow validation is unavailable", formatOf(globals)));
        return;
      }
      const result = await workflows.validate();
      const text = result.ok
        ? "Workflows valid\n"
        : result.errors.map((error) => `${error.file}:${error.path}: ${error.message}\n`).join("");
      context.emit({
        stdout: globals.json === true ? `${JSON.stringify(result)}\n` : result.ok ? text : "",
        stderr: globals.json === true || result.ok ? "" : text,
        exitCode: result.ok ? 0 : 1,
      });
    });
}
