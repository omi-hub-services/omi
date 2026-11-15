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
import type { StatusReport } from "../../../application/use-cases/project/report-status.js";
import { renderReportText } from "../presenters/status-presenter.js";

export interface OverviewCommands {
  status(projectDir: string): Promise<StatusReport>;
  watch(input: {
    projectDir: string;
    port: number;
    intervalMs: number;
    onListening: (url: string) => void;
  }): Promise<void>;
}

/** `status`: asks the runtime over IPC what it reports. Parses, sends, presents; nothing else. */
export function registerStatusCommand(
  program: Command,
  context: CliContext,
  overview?: OverviewCommands,
): void {
  program
    .command("status")
    .description("Summarise tasks, PRs, workers, quota and the next task")
    .option("--project <path>", "project directory", ".")
    .option("--runtime", "inspect the runtime over IPC")
    .option("--run <id>", "report this run and its steps instead of the runtime")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        GlobalOptions & { run?: string; project: string; runtime?: boolean }
      >();
      if (overview !== undefined && options.run === undefined && options.runtime !== true) {
        const report = await overview.status(options.project);
        context.emit(presentSuccess(report, renderReportText(report), formatOf(options)));
        return;
      }
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
  program
    .command("watch")
    .description("Watch runtime workflow diagrams in a local browser")
    .option("--project <path>", "project directory", ".")
    .option("--port <number>", "loopback port (0 chooses an available port)", "4381")
    .option("--interval <seconds>", "snapshot refresh interval", "5")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        GlobalOptions & { project: string; port: string; interval: string }
      >();
      const port = Number(options.port);
      const seconds = Number(options.interval);
      if (
        !/^\d+$/.test(options.port) ||
        !Number.isInteger(port) ||
        port < 0 ||
        port > 65535 ||
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        seconds > 2147483
      ) {
        context.emit(presentUsageError("invalid watch port or interval", formatOf(options)));
        return;
      }
      if (overview === undefined) throw new Error("OVERVIEW_NOT_WIRED");
      await overview.watch({
        projectDir: options.project,
        port,
        intervalMs: Math.max(1, Math.round(seconds * 1000)),
        onListening: (url) => {
          context.emit(presentSuccess({ url }, `watch: ${url}`, formatOf(options)));
        },
      });
    });
}
