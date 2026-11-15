import { runtimeStatusSchema } from "../../../application/contracts/runtime-status.js";
import type { RuntimeStatus } from "../../../application/contracts/runtime-status.js";
import type { IpcOutcome } from "../../ipc/protocol.js";
import { presentFailure, presentSuccess } from "./result-presenter.js";
import type { OutputFormat, Presented } from "./result-presenter.js";
import type {
  StatusReport,
  TaskLine,
} from "../../../application/use-cases/project/report-status.js";

export function renderReportText(report: StatusReport): string {
  const task = (line: TaskLine) => `#${String(line.number)} ${line.planKey ?? ""} ${line.title}`;
  return [
    `status: ${report.generatedAt}`,
    ...report.statuses.flatMap((group) => [
      `${group.status}: ${String(group.tasks.length)}`,
      ...group.tasks.map((line) => `  ${task(line)}`),
    ]),
    `next: ${report.next === null ? "none" : task(report.next)}`,
    `PRs: ${String(report.pulls.length)}`,
    ...report.pulls.map(
      (pull) =>
        `  #${String(pull.number)} ${pull.title} | checks ${pull.checks.summary} | review ${pull.review}${pull.draft ? " | draft" : ""}`,
    ),
    `workers: ${String(report.workers.length)}`,
    ...report.workers.map(
      (worker) =>
        `  #${String(worker.issueNumber)} ${worker.stepId} ${worker.role ?? "unknown"} ${worker.executor} ${worker.profileId} ${worker.model} since ${worker.startedAt}`,
    ),
    ...(report.quota === null
      ? ["quota: not configured"]
      : [
          "quota:",
          ...report.quota.map(
            (quota) =>
              `  ${quota.profileId} 5h ${String(quota.fiveHourLeft ?? "unknown")} / 7d ${String(quota.sevenDayLeft ?? "unknown")} (${quota.freshness}) ${quota.blocked.join(", ")}${quota.blockedUntil === null ? "" : ` until ${quota.blockedUntil}`}`,
          ),
        ]),
  ].join("\n");
}

export function renderStatusText(status: RuntimeStatus): string {
  return [
    `runtime: ${status.state}`,
    `version: ${status.runtimeVersion}`,
    `started: ${status.startedAt}`,
    ...(status.runs ?? []).map(({ runId, status: runStatus }) => `run: ${runId} ${runStatus}`),
    ...(status.attempts ?? []).map(
      ({ attemptId, settings }) =>
        `attempt: ${attemptId} model: ${settings.chosen.model} effort: ${settings.chosen.effort}` +
        ` reason: ${settings.selectionReason ?? "unrecorded"}` +
        ` actual model: ${settings.actualModel ?? "unreported"} effort: ${settings.actualEffort ?? "unreported"}`,
    ),
  ].join("\n");
}

/**
 * Renders the answer to `status`. The runtime's result is validated again here, so an answer of
 * the wrong shape is reported as a protocol error instead of being printed as if it were status.
 */
export function presentStatus(outcome: IpcOutcome, format: OutputFormat): Presented {
  if (!outcome.ok) return presentFailure(outcome.error, format);
  const status = runtimeStatusSchema.safeParse(outcome.result);
  if (!status.success) {
    return presentFailure(
      { code: "PROTOCOL_ERROR", message: "the runtime returned an invalid status payload" },
      format,
    );
  }
  return presentSuccess(status.data, renderStatusText(status.data), format);
}
