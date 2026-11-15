import {
  eligibleNativeApprovals,
  nativeApprovalRefusals,
} from "../approvals/native-approval-policy.js";
import type { NativeApprovalInputs } from "../approvals/native-approval-policy.js";
import { isApprovalActorAllowed } from "../approvals/approval-policy.js";
import { decide } from "../shared/decision.js";
import type { Decision } from "../shared/decision.js";
import { planKeyOfBranch } from "../tasks/plan-key.js";
import { mergeableRefusals, requiredCheckRefusals } from "./merge-policy.js";
import type { CheckObservation, MergeableState, MergeRefusal } from "./merge-policy.js";

/**
 * Release policy (product-overview: branch flow). A release is the PR `develop` → `main`; there is
 * no substitute release branch and nothing here merges into `main` — the PR waits for the PO
 * (AGENTS.md §8). Pure: the use case passes in the pulls it read.
 */
export const RELEASE_HEAD = "develop";
export const RELEASE_BASE = "main";

/** A PR that was merged into `develop`, as read from GitHub. */
export interface MergedPull {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  /** ISO-8601 UTC merge time. */
  readonly mergedAt: string;
}

export interface ReleaseTask {
  readonly pullNumber: number;
  readonly title: string;
  /** `OMI-037` style key taken from the task branch name; undefined for a non-task branch. */
  readonly taskKey: string | undefined;
  /** Issue named by the PR body's `Issue: #N` line. */
  readonly issueNumber: number | undefined;
}

const ISSUE_LINE = /^Issue: #(\d+)\s*$/m;

/**
 * The tasks released by the next release: PRs merged into `develop` strictly after the last
 * release PR was merged into `main` (all of them when there was none), oldest first.
 */
export function releaseTasks(
  pulls: readonly MergedPull[],
  lastReleaseMergedAt: string | undefined,
  /** Inclusive upper bound: the merge time of the release PR that is being published. */
  releaseMergedAt?: string,
): ReleaseTask[] {
  const since = lastReleaseMergedAt === undefined ? -Infinity : Date.parse(lastReleaseMergedAt);
  const until = releaseMergedAt === undefined ? Infinity : Date.parse(releaseMergedAt);
  return pulls
    .filter((pull) => Date.parse(pull.mergedAt) > since && Date.parse(pull.mergedAt) <= until)
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number)
    .map((pull) => {
      const key = planKeyOfBranch(pull.head);
      const issue = ISSUE_LINE.exec(pull.body)?.[1];
      return {
        pullNumber: pull.number,
        title: pull.title,
        taskKey: key,
        issueNumber: issue === undefined ? undefined : Number(issue),
      };
    });
}

export function releaseIssueKey(repository: string, release: string): string {
  return `create-release-issue:${repository}:${release}`;
}

export function releasePullKey(repository: string, release: string): string {
  return `create-release-pr:${repository}:${release}:${RELEASE_HEAD}:${RELEASE_BASE}`;
}

function taskLines(tasks: readonly ReleaseTask[]): string[] {
  return tasks.map((task) => {
    const refs = [
      task.taskKey,
      task.issueNumber === undefined ? undefined : `Issue #${String(task.issueNumber)}`,
      `PR #${String(task.pullNumber)}`,
    ].filter((part) => part !== undefined);
    // One line per task, so a PR title (untrusted text) cannot add lines of its own.
    return `- ${refs.join(" · ")}: ${task.title.replace(/\s+/g, " ").trim()}`;
  });
}

export function releaseIssueBody(release: string, tasks: readonly ReleaseTask[]): string {
  return [
    `Release: ${release}`,
    `Branch flow: ${RELEASE_HEAD} → ${RELEASE_BASE}; the PO approves and merges the release PR.`,
    "",
    "## Tasks in this release",
    ...taskLines(tasks),
  ].join("\n");
}

export function releasePullBody(
  release: string,
  releaseIssueNumber: number,
  tasks: readonly ReleaseTask[],
): string {
  return [
    `Release Issue: #${String(releaseIssueNumber)}`,
    `Release: ${release}`,
    "",
    "## Tasks in this release",
    ...taskLines(tasks),
  ].join("\n");
}

/** Automatic closing keywords must never come from untrusted task titles. */
export function hasClosingReference(text: string): boolean {
  return /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#|[\w.-]+\/[\w.-]+#|https:\/\/github\.com\/)/i.test(
    text,
  );
}

/** True only for exactly develop → main. */
export function isReleaseBranchFlow(head: string, base: string): boolean {
  return head === RELEASE_HEAD && base === RELEASE_BASE;
}

/** Snapshot read for this PR immediately before the release merge decision. */
export interface ReleaseMergeInputs {
  readonly headRef: string;
  readonly baseRef: string;
  readonly open: boolean;
  readonly expectedHeadSha: string;
  readonly currentHeadSha: string;
  readonly poActors: readonly string[];
  readonly nativeApproval: NativeApprovalInputs;
  readonly requiredChecks: readonly string[];
  readonly checks: readonly CheckObservation[];
  readonly canMerge: boolean;
  readonly mergeableState: MergeableState;
}

export type ReleaseMergeRefusal =
  | MergeRefusal
  | "WRONG_RELEASE_BRANCH_FLOW"
  | "PR_NOT_OPEN"
  | "PO_APPROVAL_MISSING"
  | "PO_APPROVAL_STALE"
  | "MERGE_PERMISSION_DENIED";

/** PO approval is a native review of this PR on this exact head, never a worker claim. */
export function evaluateReleaseMerge(input: ReleaseMergeInputs): Decision<ReleaseMergeRefusal> {
  const refusals: ReleaseMergeRefusal[] = [];
  if (!isReleaseBranchFlow(input.headRef, input.baseRef))
    refusals.push("WRONG_RELEASE_BRANCH_FLOW");
  if (!input.open) refusals.push("PR_NOT_OPEN");
  if (input.expectedHeadSha !== input.currentHeadSha) refusals.push("HEAD_MOVED");
  if (!input.canMerge) refusals.push("MERGE_PERMISSION_DENIED");
  const native = input.nativeApproval;
  const po = eligibleNativeApprovals(native).filter((review) =>
    isApprovalActorAllowed(review.actor, "github-actor", input.poActors),
  );
  if (!po.some((review) => review.commitSha === input.currentHeadSha)) {
    refusals.push(po.length > 0 ? "PO_APPROVAL_STALE" : "PO_APPROVAL_MISSING");
  }
  refusals.push(...nativeApprovalRefusals(native, input.currentHeadSha));
  refusals.push(...requiredCheckRefusals(input.requiredChecks, input.checks, input.currentHeadSha));
  refusals.push(...mergeableRefusals(input.mergeableState));
  return decide(refusals);
}

export function releaseTagKey(repository: string, release: string): string {
  return `create-release-tag:${repository}:${release}`;
}

export function releaseArtifactKey(repository: string, release: string): string {
  return `create-github-release:${repository}:${release}`;
}

/** Release notes = changelog of the release: the exact commit on main and the tasks it shipped. */
export function releaseNotes(
  release: string,
  releasePullNumber: number,
  commitSha: string,
  tasks: readonly ReleaseTask[],
): string {
  return [
    `Release: ${release}`,
    `Release PR: #${String(releasePullNumber)}`,
    `Commit: ${commitSha}`,
    "",
    "## Tasks in this release",
    ...taskLines(tasks),
  ].join("\n");
}

export interface ReleaseArtifactInputs {
  readonly headRef: string;
  readonly baseRef: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  /** Whether the merge commit is reachable from the current head of `main`. */
  readonly onMain: boolean;
}

export type ReleaseArtifactRefusal =
  | "WRONG_RELEASE_BRANCH_FLOW"
  | "RELEASE_PR_NOT_MERGED"
  | "MERGE_COMMIT_MISSING"
  | "MERGE_COMMIT_NOT_ON_MAIN";

/**
 * Tag, notes and GitHub Release exist only after the release PR is merged into `main`, and always
 * name that merge commit. An open or closed-unmerged PR never qualifies.
 */
export function evaluateReleaseArtifacts(
  input: ReleaseArtifactInputs,
): Decision<ReleaseArtifactRefusal> {
  const refusals: ReleaseArtifactRefusal[] = [];
  if (!isReleaseBranchFlow(input.headRef, input.baseRef))
    refusals.push("WRONG_RELEASE_BRANCH_FLOW");
  if (!input.merged || input.state !== "closed") refusals.push("RELEASE_PR_NOT_MERGED");
  else if (input.mergeCommitSha === null) refusals.push("MERGE_COMMIT_MISSING");
  else if (!input.onMain) refusals.push("MERGE_COMMIT_NOT_ON_MAIN");
  return decide(refusals);
}
