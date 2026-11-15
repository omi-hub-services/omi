import { taskReadinessReasons } from "../../../domain/tasks/readiness-gate.js";
import { setTaskStatusSchema } from "../../contracts/task-intake.js";
import type { GatedStatus } from "../../contracts/task-intake.js";
import type { GithubTaskBoard } from "../../ports/github-task-board.js";

export type SetTaskStatusResult =
  | { readonly kind: "set"; readonly issueNumber: number; readonly status: GatedStatus }
  | { readonly kind: "done"; readonly issueNumber: number; readonly status: GatedStatus }
  | { readonly kind: "refused"; readonly reasons: readonly string[] };

/**
 * Moves a task to Ready or In Progress, but only when the readiness gate passes (ADR-0014). The
 * gate runs first, so an Issue already at the status still has to pass; nothing is written on a
 * refusal. Only the gated statuses are accepted, so this cannot be a way around other gates.
 */
export async function setTaskStatus(
  deps: { readonly board: GithubTaskBoard },
  input: unknown,
): Promise<SetTaskStatusResult> {
  const request = setTaskStatusSchema.parse(input);
  const task = await deps.board.read(request.issueNumber);
  if (task === undefined)
    return { kind: "refused", reasons: [`#${String(request.issueNumber)} is not on the Project`] };
  const reasons = taskReadinessReasons(task);
  if (reasons.length > 0) return { kind: "refused", reasons };
  if (task.status === request.status)
    return { kind: "done", issueNumber: request.issueNumber, status: request.status };
  await deps.board.setStatus(request.issueNumber, request.status);
  return { kind: "set", issueNumber: request.issueNumber, status: request.status };
}
