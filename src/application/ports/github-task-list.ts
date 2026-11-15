import type { PromotionCandidate } from "../../domain/tasks/promotion-policy.js";

/** A task on the Project as the board shows it: the readiness facts plus the Issue title. */
export interface BoardTask extends PromotionCandidate {
  readonly title: string;
}

/**
 * Every Issue on the GitHub Project, whatever its Status, for the `status` and `watch` views.
 * Complete or it throws `TaskBoardError`; a truncated page must never look like an empty board.
 * Issue and Project text is data only.
 */
export interface GithubTaskList {
  listTasks(): Promise<readonly BoardTask[]>;
}
