import { judgePromotion, selectPromotable } from "../../../domain/tasks/promotion-policy.js";
import { promoteTaskSchema } from "../../contracts/task-intake.js";
import type { GithubTaskBoard } from "../../ports/github-task-board.js";
import { setTaskStatus } from "./set-task-status.js";

export type PromoteTaskResult =
  | { readonly kind: "promoted"; readonly issueNumber: number }
  | { readonly kind: "would_promote"; readonly issueNumber: number }
  | { readonly kind: "done"; readonly note: string }
  | { readonly kind: "refused"; readonly reason: string }
  /** Without an Issue number and nothing eligible. */
  | { readonly kind: "none" };

/**
 * Backlog → Ready, only when every blocker is closed and the readiness gate passes. Without an
 * Issue number the first eligible Backlog task is taken. The write is `setTaskStatus`, so the gate
 * is enforced again on the status transition itself.
 */
export async function promoteTask(
  deps: { readonly board: GithubTaskBoard },
  input: unknown,
): Promise<PromoteTaskResult> {
  const request = promoteTaskSchema.parse(input);
  let issueNumber = request.issueNumber;
  if (issueNumber === undefined) {
    const first = selectPromotable(await deps.board.listBacklog())[0];
    if (first === undefined) return { kind: "none" };
    issueNumber = first.number;
  } else {
    const task = await deps.board.read(issueNumber);
    if (task === undefined)
      return { kind: "refused", reason: `#${String(issueNumber)} is not on the Project` };
    const verdict = judgePromotion(task);
    if (verdict.kind === "refuse") return { kind: "refused", reason: verdict.reason };
    if (verdict.kind === "done") return verdict;
  }
  if (request.dryRun) return { kind: "would_promote", issueNumber };
  const moved = await setTaskStatus(deps, { issueNumber, status: "Ready" });
  if (moved.kind === "refused")
    return { kind: "refused", reason: `#${String(issueNumber)}: ${moved.reasons.join("; ")}` };
  return { kind: "promoted", issueNumber };
}
