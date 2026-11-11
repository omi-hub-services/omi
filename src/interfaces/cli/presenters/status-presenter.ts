import { runtimeStatusSchema } from "../../../application/contracts/runtime-status.js";
import type { RuntimeStatus } from "../../../application/contracts/runtime-status.js";
import type { IpcOutcome } from "../../ipc/protocol.js";
import { presentFailure, presentSuccess } from "./result-presenter.js";
import type { OutputFormat, Presented } from "./result-presenter.js";

export function renderStatusText(status: RuntimeStatus): string {
  return [
    `runtime: ${status.state}`,
    `version: ${status.runtimeVersion}`,
    `started: ${status.startedAt}`,
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
