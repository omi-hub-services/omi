import { parseAcReviewLines } from "../../../domain/delivery/acceptance-review.js";
import {
  evaluateIssueClose,
  evaluateMerge,
  evaluateMergeConfirmation,
} from "../../../domain/delivery/merge-policy.js";
import type { ReviewObservation } from "../../../domain/delivery/merge-policy.js";
import { hasOperationMarker, operationMarker } from "../../../domain/delivery/operation-marker.js";
import {
  acceptanceCriteria,
  tickAcceptanceCriteria,
} from "../../../domain/tasks/acceptance-criteria.js";
import { transitionTask } from "../../../domain/tasks/task-status.js";
import type { TaskStatus } from "../../../domain/tasks/task-status.js";
import type { GithubOperation } from "../../contracts/github-operation.js";
import {
  branchRulesSchema,
  checkObservationsSchema,
  issueStateSchema,
  mergeCommitSchema,
  mergeEvidenceSchema,
  mergePullSchema,
  mergeTaskPrSchema,
  nativeReviewsSchema,
} from "../../contracts/merge-delivery.js";
import type {
  IssueState,
  MergeEvidence,
  MergePull,
  MergeTaskPrRequest,
} from "../../contracts/merge-delivery.js";
import type { BranchSync } from "../../ports/branch-sync.js";
import { prMappingSchema, pullRequestCreationKey } from "../../contracts/pr-delivery.js";
import type { LeaseStore } from "../../ports/lease-store.js";
import type {
  MergeDeliveryReader,
  MergeEvidenceReader,
  TaskCompletionStore,
} from "../../ports/merge-delivery.js";
import { resolveCarriedEvidence } from "../../services/resolve-carried-review.js";
import { DeliveryError } from "../../ports/pr-delivery.js";
import type { PrMappingStore } from "../../ports/pr-delivery.js";
import {
  deliverGithubOperation,
  reconcileGithubOperation,
} from "../../services/deliver-github-operation.js";
import type { DeliverGithubOperationDeps } from "../../services/deliver-github-operation.js";

/** Task PRs merge into the integration branch only (AGENTS.md §8). */
const INTEGRATION_BRANCH = "develop";

export type MergeTaskPrDeps = DeliverGithubOperationDeps & {
  readonly reader: MergeDeliveryReader;
  readonly evidence: MergeEvidenceReader;
  readonly mappings: PrMappingStore;
  readonly tasks: TaskCompletionStore;
  readonly leases: LeaseStore;
  /** Identity of this runtime as merge-lock holder. */
  readonly mergeLockOwner: string;
  /** A merge lock outlives a crashed holder by at most this long. */
  readonly mergeLockTtlMs: number;
  /** Git reads that let a PASS carry over clean syncs with develop (OMI-080). Absent: no carrying. */
  readonly carry?: Pick<BranchSync, "facts">;
  /** Best-effort follow-up once the task is recorded Done (e.g. worker log retention). */
  readonly afterDone?: (taskId: string) => Promise<void>;
};

export type MergeTaskPrStep = "merge" | "confirm" | "tick" | "close" | "done";

export type MergeTaskPrResult =
  | { readonly status: "done"; readonly mergeCommitSha: string; readonly ticked: number }
  /** An operation is not settled yet; call again later (its outcome is read back first). */
  | {
      readonly status: "pending";
      readonly step: MergeTaskPrStep;
      readonly operationKey: string;
      readonly state: string;
    }
  | {
      readonly status: "refused";
      readonly step: MergeTaskPrStep;
      readonly reasons: readonly string[];
    };

type Pending = Extract<MergeTaskPrResult, { status: "pending" }>;
type Refused = Extract<MergeTaskPrResult, { status: "refused" }>;

const refused = (step: MergeTaskPrStep, reasons: readonly string[]): Refused => ({
  status: "refused",
  step,
  reasons,
});

/**
 * Merges a mapped task PR into `develop` only when every gate holds on the exact reviewed head,
 * then completes the task: tick the Issue's criteria from the review's `AC-<n>: met` lines, close
 * the Issue, record Done (architecture.md §11 "PR vào develop", ADR-0025, ADR-0026).
 *
 * Every remote write is an outbox operation keyed by PR and reviewed head, and each call first
 * reads back what earlier attempts did, so a retry after a crash never merges, ticks or closes
 * twice. Run serially on the runtime writer, like the other delivery use cases.
 */
export async function mergeTaskPr(
  deps: MergeTaskPrDeps,
  input: unknown,
): Promise<MergeTaskPrResult> {
  const request = mergeTaskPrSchema.parse(input);
  const mapping = prMappingSchema.safeParse(deps.mappings.get(request.projectId, request.taskId));
  if (
    !mapping.success ||
    mapping.data.repository !== request.repository ||
    mapping.data.issueNumber !== request.issueNumber ||
    mapping.data.prNumber !== request.prNumber
  ) {
    throw new DeliveryError("MAPPING_MISMATCH");
  }
  const keys = operationKeys(request);

  // A lost response of an earlier merge call is found by read-back before anything is decided.
  await reconcileGithubOperation(deps, keys.merge);
  let pull = await readPull(deps, request);
  if (!pull.merged) {
    const merge = await mergeUnderLock(deps, request, keys.merge);
    if (merge !== undefined) return merge;
    pull = await readPull(deps, request);
  }

  const mergeCommitSha = await confirmMerge(deps, request, pull);
  if (typeof mergeCommitSha !== "string") return mergeCommitSha;
  return completeTask(deps, request, keys, pull.headSha, mergeCommitSha);
}

interface OperationKeys {
  readonly merge: string;
  readonly tick: string;
  readonly close: string;
}

/** Stable intents (design-patterns.md §7): a merge operation names the PR and expected head. */
function operationKeys(request: MergeTaskPrRequest): OperationKeys {
  const pr = `${request.repository}#${String(request.prNumber)}@${request.reviewedHeadSha}`;
  const issue = `${request.repository}#${String(request.issueNumber)}@${request.reviewedHeadSha}`;
  const keys = { merge: `merge-pr:${pr}`, tick: `tick-ac:${issue}`, close: `close-issue:${issue}` };
  for (const key of Object.values(keys)) operationMarker(key);
  return keys;
}

/** Undefined when the merge took effect; otherwise why it did not (yet). */
async function mergeUnderLock(
  deps: MergeTaskPrDeps,
  request: MergeTaskPrRequest,
  mergeKey: string,
): Promise<Pending | Refused | undefined> {
  const resourceKey = `merge-queue:${request.repository}:${INTEGRATION_BRANCH}`;
  const acquiredAt = deps.now();
  const lock = deps.leases.acquire({
    resourceKey,
    owner: deps.mergeLockOwner,
    now: iso(acquiredAt),
    expiresAt: iso(acquiredAt + deps.mergeLockTtlMs),
  });
  try {
    // Everything is read again under the lock: the decision is about the remote as it is now.
    const pull = await readPull(deps, request);
    if (pull.merged) return undefined;
    if (pull.state !== "open") return refused("merge", ["PULL_REQUEST_CLOSED"]);
    const { repository } = request;
    // The merge intent names the PR's creation intent; its marker proves this is the task's PR.
    const prOperationKey = pullRequestCreationKey(repository, request.taskId, pull.headRef);
    if (!hasOperationMarker(pull.body, prOperationKey)) {
      return refused("merge", ["PR_NOT_CORRELATED"]);
    }
    const [baseSha, rules, issue, checks, reviews, actor] = await Promise.all([
      deps.reader.branchHead(repository, INTEGRATION_BRANCH),
      deps.reader.branchRules(repository, INTEGRATION_BRANCH),
      readIssue(deps, request),
      deps.reader.checks(repository, pull.headSha),
      deps.reader.nativeReviews(repository, request.prNumber),
      deps.reader.authenticatedActor(),
    ]);
    const parsedRules = branchRulesSchema.parse(rules);
    const evidence = readEvidence(deps, request, request.reviewedHeadSha);
    const decision = evaluateMerge({
      pullRequestId: `${repository}#${String(request.prNumber)}`,
      kind: "task",
      targetBranch: pull.baseRef,
      expectedTargetBranch: INTEGRATION_BRANCH,
      expectedHeadSha: request.reviewedHeadSha,
      currentHeadSha: pull.headSha,
      currentBaseSha: shaOf(baseSha),
      linkedIssueConfirmed: linksOnlyIssue(pull.body, request.issueNumber),
      mergeableState: pull.mergeableState,
      review: reviewObservation(evidence),
      acceptanceCriteriaCount: acceptanceCriteria(issue.body).length,
      authorRunIds: evidence.authorRunIds,
      authorAgentIds: evidence.authorAgentIds,
      requiredChecks: [...new Set([...request.requiredChecks, ...parsedRules.requiredChecks])],
      checks: checkObservationsSchema.parse(checks),
      unresolvedMandatoryFindings: evidence.unresolvedMandatoryFindings,
      workflowGatesPassed: evidence.workflowGatesPassed,
      requiredApprovals: [],
      nativeApproval: {
        requiredCount: Math.max(
          parsedRules.requiredApprovingReviewCount,
          request.minimumNativeApprovals,
        ),
        pullAuthor: pull.author,
        runtimeActors: [actor],
        reviews: nativeReviewsSchema.parse(reviews),
      },
      mergeLockHeld: lock.ok,
    });
    if (!decision.allowed) return refused("merge", decision.reasons);

    const outcome = await deliverGithubOperation(deps, mergeKey, {
      type: "pull_request.merge",
      repo: repository,
      pullNumber: request.prNumber,
      base: INTEGRATION_BRANCH,
      expectedHeadSha: request.reviewedHeadSha,
      prOperationKey,
    });
    if (outcome.kind === "pending") return pendingAt("merge", outcome);
    // GitHub refused after every local gate passed (e.g. protection the runtime cannot see).
    if (outcome.kind === "failed") return refused("merge", ["MERGE_REJECTED", outcome.code]);
    return undefined;
  } finally {
    if (lock.ok) {
      deps.leases.release({
        resourceKey,
        owner: deps.mergeLockOwner,
        generation: lock.lease.generation,
        now: iso(deps.now()),
      });
    }
  }
}

/** The merge commit SHA once the remote confirms the merge, otherwise the refusal. */
async function confirmMerge(
  deps: MergeTaskPrDeps,
  request: MergeTaskPrRequest,
  pull: MergePull,
): Promise<string | Refused> {
  const mergeSha = pull.mergeCommitSha;
  const commit =
    pull.merged && mergeSha !== null
      ? mergeCommitSchema.parse(await deps.reader.commit(request.repository, mergeSha))
      : undefined;
  const onTarget =
    mergeSha !== null &&
    commit?.sha === mergeSha &&
    (await deps.reader.branchContains(request.repository, INTEGRATION_BRANCH, mergeSha));
  const decision = evaluateMergeConfirmation({
    merged: pull.merged,
    targetBranch: pull.baseRef,
    expectedTargetBranch: INTEGRATION_BRANCH,
    mergedHeadSha: pull.headSha,
    expectedHeadSha: request.reviewedHeadSha,
    mergeCommitSha: mergeSha,
    mergeCommitParents: commit?.parents ?? [],
    mergeCommitOnTarget: onTarget,
  });
  if (!decision.allowed) return refused("confirm", decision.reasons);
  return mergeSha ?? "";
}

/** Tick the criteria, close the Issue, then record Done; each part is skipped when done. */
async function completeTask(
  deps: MergeTaskPrDeps,
  request: MergeTaskPrRequest,
  keys: OperationKeys,
  mergedHeadSha: string,
  mergeCommitSha: string,
): Promise<MergeTaskPrResult> {
  await reconcileGithubOperation(deps, keys.tick);
  await reconcileGithubOperation(deps, keys.close);
  const status = deps.tasks.status(request.projectId, request.taskId);
  let issue = await readIssue(deps, request);
  if (status === "done" && issue.state === "closed") {
    return { status: "done", mergeCommitSha, ticked: 0 };
  }

  const evidence = readEvidence(deps, request, mergedHeadSha);
  const decision = evaluateIssueClose({
    merged: true,
    mergedHeadSha,
    review: reviewObservation(evidence),
    acceptanceCriteriaCount: acceptanceCriteria(issue.body).length,
    authorRunIds: evidence.authorRunIds,
    authorAgentIds: evidence.authorAgentIds,
  });
  if (!decision.allowed) return refused("tick", decision.reasons);
  // Decide Done before any write, so the Issue is never closed for a task that cannot be Done.
  const done = status === "done" ? undefined : doneTransition(status);
  if (done !== undefined && !done.ok) return refused("done", [done.reason]);

  const tick = tickAcceptanceCriteria(issue.body);
  if (tick.newly > 0) {
    const write = await deliverStep("tick", deps, keys.tick, {
      type: "issue.update_body",
      repo: request.repository,
      issueNumber: request.issueNumber,
      fromBody: issue.body,
      body: tick.body,
    });
    if (write !== undefined) return write;
    issue = await readIssue(deps, request);
    if (tickAcceptanceCriteria(issue.body).newly !== 0) {
      throw new DeliveryError("AC_TICK_VERIFICATION_FAILED");
    }
  }

  if (issue.state === "open") {
    const write = await deliverStep("close", deps, keys.close, {
      type: "issue.close",
      repo: request.repository,
      issueNumber: request.issueNumber,
    });
    if (write !== undefined) return write;
    if ((await readIssue(deps, request)).state !== "closed") {
      throw new DeliveryError("ISSUE_CLOSE_VERIFICATION_FAILED");
    }
  }

  if (done?.ok === true) {
    const saved = deps.tasks.complete({
      projectId: request.projectId,
      taskId: request.taskId,
      expectedStatus: done.from,
      toStatus: done.to,
      mergeCommitSha,
      at: iso(deps.now()),
    });
    if (!saved.ok) throw new DeliveryError(`TASK_${saved.reason}`);
    // A failed follow-up must never undo or hide a completed merge.
    await deps.afterDone?.(request.taskId).catch(() => undefined);
  }
  return { status: "done", mergeCommitSha, ticked: tick.newly };
}

/** The domain task machine decides Done: acceptance met and the merge confirmed on the remote. */
function doneTransition(
  status: TaskStatus | undefined,
):
  | { readonly ok: true; readonly from: TaskStatus; readonly to: TaskStatus }
  | { readonly ok: false; readonly reason: string } {
  if (status === undefined) return { ok: false, reason: "TASK_NOT_FOUND" };
  const outcome = transitionTask(status, {
    type: "completion_confirmed",
    acceptanceMet: true,
    changesCode: true,
    mergeConfirmed: true,
    outputAccepted: false,
  });
  return outcome.ok
    ? { ok: true, from: status, to: outcome.to }
    : { ok: false, reason: outcome.reason };
}

async function deliverStep(
  step: MergeTaskPrStep,
  deps: MergeTaskPrDeps,
  key: string,
  operation: GithubOperation,
): Promise<Pending | Refused | undefined> {
  const outcome = await deliverGithubOperation(deps, key, operation);
  if (outcome.kind === "pending") return pendingAt(step, outcome);
  if (outcome.kind === "failed") return refused(step, ["GITHUB_REJECTED", outcome.code]);
  return undefined;
}

function pendingAt(
  step: MergeTaskPrStep,
  outcome: { readonly operationKey: string; readonly state: string },
): Pending {
  return { status: "pending", step, operationKey: outcome.operationKey, state: outcome.state };
}

async function readPull(deps: MergeTaskPrDeps, request: MergeTaskPrRequest): Promise<MergePull> {
  const pull = mergePullSchema.parse(await deps.reader.pull(request.repository, request.prNumber));
  if (pull.number !== request.prNumber || pull.repository !== request.repository) {
    throw new DeliveryError("PR_IDENTITY_MISMATCH");
  }
  return pull;
}

async function readIssue(deps: MergeTaskPrDeps, request: MergeTaskPrRequest): Promise<IssueState> {
  const issue = issueStateSchema.parse(
    await deps.reader.issue(request.repository, request.issueNumber),
  );
  if (issue.number !== request.issueNumber) throw new DeliveryError("ISSUE_IDENTITY_MISMATCH");
  return issue;
}

function readEvidence(
  deps: MergeTaskPrDeps,
  request: MergeTaskPrRequest,
  headSha: string,
): MergeEvidence {
  const raw =
    deps.carry === undefined
      ? deps.evidence.read(request.projectId, request.taskId, headSha)
      : resolveCarriedEvidence(
          { evidence: deps.evidence, sync: deps.carry },
          request.projectId,
          request.taskId,
          headSha,
        );
  const parsed = mergeEvidenceSchema.safeParse(raw);
  if (!parsed.success) throw new DeliveryError("MERGE_EVIDENCE_INVALID");
  // Evidence for another head is never evidence for this one.
  if (parsed.data.review !== undefined && parsed.data.review.headSha !== headSha) {
    return { ...parsed.data, review: undefined };
  }
  return parsed.data;
}

function reviewObservation(evidence: MergeEvidence): ReviewObservation | undefined {
  const review = evidence.review;
  if (review === undefined) return undefined;
  return {
    reviewerRunId: review.reviewerRunId,
    reviewerAgentId: review.reviewerAgentId,
    headSha: review.headSha,
    baseSha: review.baseSha,
    passed: review.verdict === "pass",
    acLines: parseAcReviewLines(review.body),
  };
}

/** `preparePr` writes exactly one `Issue: #N` line; any other Issue reference breaks the link. */
function linksOnlyIssue(body: string, issueNumber: number): boolean {
  const linked = new Set(
    [...body.matchAll(/^Issue: #(\d+)\s*$/gm)].map((match) => Number(match[1])),
  );
  return linked.size === 1 && linked.has(issueNumber);
}

function shaOf(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new DeliveryError("INVALID_BRANCH_HEAD");
  return value;
}

const iso = (ms: number): string => new Date(ms).toISOString();
