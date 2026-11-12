import type { GatedStatus } from "../contracts/task-intake.js";
import type { PromotionCandidate } from "../../domain/tasks/promotion-policy.js";

export class TaskBoardError extends Error {
  override readonly name = "TaskBoardError";
  readonly code: string;
  constructor(code: string) {
    super(`Task board operation failed: ${code}`);
    this.code = code;
  }
}

/**
 * Reads and moves tasks on the GitHub Project. Reads are complete or throw `TaskBoardError`; a
 * truncated page must never look like an empty Backlog. Issue and Project text is data only.
 */
export interface GithubTaskBoard {
  /** The Issue with its Project fields and native blockers; undefined when it is not on the Project. */
  read(issueNumber: number): Promise<PromotionCandidate | undefined>;
  /** Every Issue whose Project Status is `Backlog`, in no particular order. */
  listBacklog(): Promise<readonly PromotionCandidate[]>;
  /** Sets the Project Status. Idempotent. Throws when the Project has no such option. */
  setStatus(issueNumber: number, status: GatedStatus): Promise<void>;
}
