import { linkedIssueNumber } from "../../../domain/delivery/pull-issue-link.js";
import type { QuotaVerdict } from "../../../domain/profiles/quota-policy.js";
import {
  groupTasksByStatus,
  selectUnblockedReady,
  suggestNextTask,
} from "../../../domain/tasks/next-task-policy.js";
import { CONTRACT_SCHEMA_VERSION } from "../../contracts/schema-version.js";
import type { BoardTask, GithubTaskList } from "../../ports/github-task-list.js";
import type { MergeDeliveryReader } from "../../ports/merge-delivery.js";
import type { OpenPullReader } from "../../ports/open-pull-reader.js";
import type { PullReviewReader } from "../../ports/pull-review-reader.js";
import type { RunOverviewReader } from "../../ports/run-overview-reader.js";

export interface TaskLine {
  readonly number: number;
  readonly title: string;
  readonly planKey: string | null;
  readonly priority: string | null;
}

export interface PullLine {
  readonly number: number;
  readonly title: string;
  readonly headSha: string;
  readonly draft: boolean;
  /** The task the PR is for (its one `Issue: #N` line); null when it does not name exactly one. */
  readonly issueNumber: number | null;
  readonly checks: {
    readonly summary: "pass" | "fail" | "pending" | "none";
    readonly passed: number;
    readonly failed: number;
    readonly pending: number;
  };
  /** The recorded independent review: of this head, of an older head (`stale`), or none yet. */
  readonly review: "pass" | "fail" | "stale" | "none";
}

export interface WorkerLine {
  readonly runId: string;
  readonly issueNumber: number;
  readonly stepId: string;
  readonly role: string | null;
  readonly executor: string;
  readonly profileId: string;
  readonly model: string;
  readonly startedAt: string;
}

export interface QuotaLine {
  readonly profileId: string;
  readonly freshness: QuotaVerdict["freshness"];
  readonly fiveHourLeft: number | null;
  readonly sevenDayLeft: number | null;
  readonly blocked: readonly string[];
  /** ISO time every blocking window has reset; null when nothing says. */
  readonly blockedUntil: string | null;
}

/** The `status` report (`--json` prints it as is). Built from runtime state plus two GitHub reads. */
export interface StatusReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly statuses: readonly { readonly status: string; readonly tasks: readonly TaskLine[] }[];
  /** Ready tasks whose blockers are all closed, in task order. */
  readonly ready: readonly TaskLine[];
  readonly next: TaskLine | null;
  readonly pulls: readonly PullLine[];
  readonly workers: readonly WorkerLine[];
  /** Null when the project has no `quota` block, so nothing was read. */
  readonly quota: readonly QuotaLine[] | null;
}

export interface StatusDeps {
  readonly board: GithubTaskList;
  readonly pulls: OpenPullReader;
  readonly checks: Pick<MergeDeliveryReader, "checks">;
  readonly reviews: PullReviewReader;
  readonly runs: RunOverviewReader;
  /** Absent when quota is not configured; never spends a subscription call. */
  readonly quota?: () => Promise<ReadonlyMap<string, QuotaVerdict>>;
  /** `owner/name`. */
  readonly repository: string;
  readonly now: () => number;
}

const line = (task: BoardTask): TaskLine => ({
  number: task.number,
  title: task.title,
  planKey: task.planKey,
  priority: task.priority,
});

/**
 * What the PO asks first: where every task stands, what to start next, which PRs wait on what,
 * who is working and how much quota is left. Every GitHub read is complete or it throws; the
 * report never shows a failed read as an empty board.
 */
export async function reportStatus(deps: StatusDeps): Promise<StatusReport> {
  const tasks = await deps.board.listTasks();
  const open = await deps.pulls.listOpen(deps.repository);
  const pulls = await Promise.all(
    open.map(async (pull): Promise<PullLine> => {
      const observed = await deps.checks.checks(deps.repository, pull.headSha);
      const count = (status: "passed" | "failed" | "pending") =>
        observed.filter((check) => check.status === status).length;
      const [passed, failed, pending] = [count("passed"), count("failed"), count("pending")];
      const issueNumber = linkedIssueNumber(pull.body) ?? null;
      const review = issueNumber === null ? undefined : deps.reviews.latest(issueNumber);
      return {
        number: pull.number,
        title: pull.title,
        headSha: pull.headSha,
        draft: pull.draft,
        issueNumber,
        checks: {
          summary: failed > 0 ? "fail" : pending > 0 ? "pending" : passed > 0 ? "pass" : "none",
          passed,
          failed,
          pending,
        },
        review:
          review === undefined
            ? "none"
            : review.headSha === pull.headSha
              ? review.verdict
              : "stale",
      };
    }),
  );
  const verdicts = deps.quota === undefined ? undefined : await deps.quota();
  const runs = deps.runs.listActive();
  const available = tasks.filter((task) => !runs.some((run) => run.issueNumber === task.number));
  const next = suggestNextTask(available);
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    generatedAt: new Date(deps.now()).toISOString(),
    statuses: groupTasksByStatus(tasks).map((group) => ({
      status: group.status,
      tasks: group.tasks.map(line),
    })),
    ready: selectUnblockedReady(available).map(line),
    next: next === undefined ? null : line(next),
    pulls,
    workers: runs.flatMap((run) =>
      run.attempts
        .filter((attempt) => attempt.status === "running")
        .map((attempt): WorkerLine => ({
          runId: run.runId,
          issueNumber: run.issueNumber,
          stepId: attempt.stepId,
          role: attempt.role ?? null,
          executor: attempt.executor,
          profileId: attempt.profileId,
          model: attempt.model,
          startedAt: attempt.startedAt,
        })),
    ),
    quota:
      verdicts === undefined
        ? null
        : [...verdicts.values()]
            .sort((a, b) => a.profileId.localeCompare(b.profileId))
            .map((verdict) => ({
              profileId: verdict.profileId,
              freshness: verdict.freshness,
              fiveHourLeft: verdict.fiveHourLeft,
              sevenDayLeft: verdict.sevenDayLeft,
              blocked: verdict.blocked,
              blockedUntil:
                verdict.blockedUntil === null ? null : new Date(verdict.blockedUntil).toISOString(),
            })),
  };
}
