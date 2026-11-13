import type { Command } from "commander";
import { syncReportSchema, syncSelectionSchema } from "../../../application/contracts/sync.js";
import { EXIT_CODES } from "../presenters/exit-codes.js";
import {
  presentFailure,
  presentSuccess,
  presentUsageError,
} from "../presenters/result-presenter.js";
import { formatOf, type CliContext, type GlobalOptions } from "./command-context.js";

export function registerSyncCommand(program: Command, context: CliContext): void {
  program
    .command("sync")
    .description("Reconcile GitHub, flush queued outbox operations and import selected Issues")
    .option("--issues <numbers...>", "explicit Issue numbers to import")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions & { issues?: string[] }>();
      const format = formatOf(options);
      const parsed = syncSelectionSchema.safeParse(
        options.issues === undefined
          ? {}
          : {
              issueNumbers: options.issues.map((n) =>
                /^[1-9]\d{0,9}$/.test(n) ? Number(n) : undefined,
              ),
            },
      );
      if (!parsed.success) {
        context.emit(presentUsageError("give 1–1000 whole Issue numbers", format));
        return;
      }
      const outcome = await context.sendCommand({
        socketPath: options.socket ?? context.defaultSocketPath,
        timeoutMs: context.timeoutMs,
        command: { schemaVersion: 1, command: "sync", ...parsed.data },
      });
      if (!outcome.ok) {
        context.emit(presentFailure(outcome.error, format));
        return;
      }
      const report = syncReportSchema.safeParse(outcome.result);
      if (!report.success) {
        context.emit(
          presentFailure({ code: "PROTOCOL_ERROR", message: "invalid sync response" }, format),
        );
        return;
      }
      const result = report.data;
      const lines = [
        ...result.reconcile.entries.map(
          (e) => `${e.operationKey} ${e.outcome}${e.code === undefined ? "" : ` ${e.code}`}`,
        ),
        ...result.attempts.map(
          (e) => `${e.operationKey} ${e.outcome}${e.code === undefined ? "" : ` ${e.code}`}`,
        ),
        ...result.snapshots.map((s) => `${s.taskId} content_hash=${s.contentHash} ${s.outcome}`),
        `githubUnavailable=${String(result.githubUnavailable)}`,
      ].join("\n");
      if (result.code === undefined) {
        context.emit(presentSuccess(result, lines, format));
      } else {
        context.emit(
          format === "json"
            ? {
                stdout: `${JSON.stringify({ schemaVersion: 1, ok: false, exitCode: EXIT_CODES.REQUEST_REJECTED, error: { code: result.code, message: "sync incomplete" }, result })}\n`,
                stderr: "",
                exitCode: EXIT_CODES.REQUEST_REJECTED,
              }
            : {
                stdout: `${lines}\n`,
                stderr: `error[${result.code}]: sync incomplete\n`,
                exitCode: EXIT_CODES.REQUEST_REJECTED,
              },
        );
      }
    });
}
