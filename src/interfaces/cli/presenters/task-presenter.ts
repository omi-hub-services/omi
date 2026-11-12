import type { CreateIssueResult } from "../../../application/use-cases/tasks/create-issue-from-spec.js";
import type { PromoteTaskResult } from "../../../application/use-cases/tasks/promote-task.js";
import type { SetTaskStatusResult } from "../../../application/use-cases/tasks/set-task-status.js";
import { presentFailure, presentSuccess } from "./result-presenter.js";
import type { OutputFormat, Presented } from "./result-presenter.js";

const refused = (message: string, format: OutputFormat): Presented =>
  presentFailure({ code: "COMMAND_REFUSED", message }, format);

export function presentCreateIssue(result: CreateIssueResult, format: OutputFormat): Presented {
  switch (result.kind) {
    case "refused":
      return refused(result.reasons.join("; "), format);
    case "exists":
      return presentSuccess(
        result,
        `done: ${result.planKey} exists on #${String(result.issueNumber)}`,
        format,
      );
    case "created":
      return presentSuccess(
        result,
        `created: #${String(result.issueNumber)} ${result.plan.planKey}`,
        format,
      );
    case "preview": {
      const { plan } = result;
      const fields = Object.entries(plan.fields)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ");
      const blockers = plan.blockedBy.map((n) => `#${String(n)}`).join(", ");
      return presentSuccess(
        result,
        [
          `preview: ${plan.planKey} (nothing written; pass --apply to create)`,
          `title: ${plan.title}`,
          `milestone: ${plan.milestone}`,
          `epic: #${String(plan.epic)}`,
          `blocked by: ${blockers === "" ? "none" : blockers}`,
          `fields: ${fields}`,
        ].join("\n"),
        format,
      );
    }
  }
}

export function presentPromotion(result: PromoteTaskResult, format: OutputFormat): Presented {
  switch (result.kind) {
    case "refused":
      return refused(result.reason, format);
    case "done":
      return presentSuccess(result, `done: ${result.note}`, format);
    case "none":
      return presentSuccess(result, "none: no Backlog task is ready to promote", format);
    case "would_promote":
      return presentSuccess(
        result,
        `would promote: #${String(result.issueNumber)} (dry run, nothing written)`,
        format,
      );
    case "promoted":
      return presentSuccess(result, `promoted: #${String(result.issueNumber)}`, format);
  }
}

export function presentStatusChange(result: SetTaskStatusResult, format: OutputFormat): Presented {
  switch (result.kind) {
    case "refused":
      return refused(result.reasons.join("; "), format);
    case "done":
      return presentSuccess(
        result,
        `done: #${String(result.issueNumber)} is already ${result.status}`,
        format,
      );
    case "set":
      return presentSuccess(result, `set: #${String(result.issueNumber)} ${result.status}`, format);
  }
}
