import type { TaskStatus } from "../../domain/tasks/task-status.js";
import type {
  BranchRules,
  CheckObservations,
  IssueState,
  MergeCommit,
  MergeEvidence,
  MergePull,
  NativeReviews,
} from "../contracts/merge-delivery.js";

/**
 * GitHub reads for a merge decision. Every read is complete and identity checked; unavailable or
 * malformed data throws (`DeliveryError`), never reads as "absent" or "passed". The use case
 * validates the results again against `contracts/merge-delivery.ts`. Writes go through the outbox
 * (`GithubRemote`), never through this reader, and nothing here creates a review or approval.
 */
export interface MergeDeliveryReader {
  pull(repository: string, number: number): Promise<MergePull>;
  issue(repository: string, number: number): Promise<IssueState>;
  /** Current commit SHA of a branch, read fresh from the remote. */
  branchHead(repository: string, branch: string): Promise<string>;
  /** Required approving review count and required checks from the branch's active rulesets. */
  branchRules(repository: string, branch: string): Promise<BranchRules>;
  /** Check runs and commit statuses reported for exactly this commit, latest per name. */
  checks(repository: string, sha: string): Promise<CheckObservations>;
  /** Native pull request reviews, oldest first. */
  nativeReviews(repository: string, number: number): Promise<NativeReviews>;
  /** The login the runtime's GitHub credential acts as. */
  authenticatedActor(): Promise<string>;
  commit(repository: string, sha: string): Promise<MergeCommit>;
  /** Whether `sha` is reachable from the branch's current head on the remote. */
  branchContains(repository: string, branch: string, sha: string): Promise<boolean>;
}

/**
 * The task's delivery evidence from local state: the recorded independent review for one head,
 * the implementing runs and agents, and the workflow's findings/gates. A review is the step
 * result of a separate run, never text the Coordinator or the implementer wrote into the PR.
 */
export interface MergeEvidenceReader {
  read(projectId: string, taskId: string, headSha: string): MergeEvidence;
}

export interface TaskCompletion {
  readonly projectId: string;
  readonly taskId: string;
  /** Compare-and-swap guard: the status the decision was made on. */
  readonly expectedStatus: TaskStatus;
  /** Target decided by the domain task machine. */
  readonly toStatus: TaskStatus;
  readonly mergeCommitSha: string;
  /** ISO-8601 UTC. */
  readonly at: string;
}

export type TaskCompletionResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "NOT_FOUND" | "STALE_STATUS" };

/** The local task lifecycle record; the store never decides a status itself. */
export interface TaskCompletionStore {
  status(projectId: string, taskId: string): TaskStatus | undefined;
  complete(change: TaskCompletion): TaskCompletionResult;
}
