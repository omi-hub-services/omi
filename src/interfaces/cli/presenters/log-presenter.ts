import type { RetainWorkerLogsResult } from "../../../application/use-cases/runs/retain-worker-logs.js";
import { EXIT_CODES } from "./exit-codes.js";
import { presentFailure, presentSuccess } from "./result-presenter.js";
import type { OutputFormat, Presented } from "./result-presenter.js";

export function presentLogRetention(
  result: RetainWorkerLogsResult,
  format: OutputFormat,
): Presented {
  if (result.failed.length > 0) {
    return presentFailure(
      {
        code: "INTERNAL_ERROR",
        message: `log retention failed for: ${result.failed.join(", ")}`,
      },
      format,
      EXIT_CODES.FAILURE,
    );
  }
  const verb = result.dryRun ? "would archive" : "archived";
  const lines = [
    `${result.dryRun ? "dry run, nothing changed; " : ""}${verb} ${String(result.archived)}, ` +
      `${result.dryRun ? "would remove" : "removed"} ${String(result.removed)} archive file(s), ` +
      `kept ${String(result.kept)}`,
    ...result.decisions
      .filter((decision) => decision.action !== "keep")
      .map((decision) => `${decision.action} ${decision.name}: ${decision.reason}`),
  ];
  return presentSuccess(result, lines.join("\n"), format);
}
