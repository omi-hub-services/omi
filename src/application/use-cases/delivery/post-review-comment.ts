import { z } from "zod";
import { reviewCommentRefusals } from "../../../domain/delivery/acceptance-review.js";
import { linkedIssueNumber } from "../../../domain/delivery/pull-issue-link.js";
import { acceptanceCriteria } from "../../../domain/tasks/acceptance-criteria.js";
import { mergePullSchema, issueStateSchema } from "../../contracts/merge-delivery.js";
import { assertCredentialFree } from "../../contracts/credential-input.js";
import type { ContentHasher } from "../../ports/content-hasher.js";
import type { MergeDeliveryReader } from "../../ports/merge-delivery.js";
import {
  deliverGithubOperation,
  type DeliverGithubOperationDeps,
} from "../../services/deliver-github-operation.js";

export interface PostReviewCommentDeps extends DeliverGithubOperationDeps {
  readonly repository: string;
  readonly reader: Pick<MergeDeliveryReader, "pull" | "issue">;
  readonly hasher: ContentHasher;
}

/** Publishes independent-review text for people; the runtime's recorded review remains authoritative. */
export async function postReviewComment(deps: PostReviewCommentDeps, input: unknown) {
  const parsed = z
    .strictObject({ prNumber: z.number().int().positive(), body: z.string().min(1).max(60_000) })
    .safeParse(input);
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!parsed.success) return refuse("INVALID_INPUT");
  assertCredentialFree(parsed.data.body);
  const pull = mergePullSchema.parse(await deps.reader.pull(deps.repository, parsed.data.prNumber));
  if (
    pull.repository !== deps.repository ||
    pull.number !== parsed.data.prNumber ||
    pull.state !== "open"
  )
    return refuse("PR_IDENTITY_MISMATCH");
  const issueNumber = linkedIssueNumber(pull.body);
  if (issueNumber === undefined) return refuse("ISSUE_LINK_REQUIRED");
  const issue = issueStateSchema.parse(await deps.reader.issue(deps.repository, issueNumber));
  if (issue.number !== issueNumber) return refuse("ISSUE_IDENTITY_MISMATCH");
  const reasons = reviewCommentRefusals(
    parsed.data.body,
    pull.headSha,
    acceptanceCriteria(issue.body).length,
  );
  if (reasons.length > 0) return refuse(reasons.join(","));
  const key = `review-comment:${deps.hasher.sha256(JSON.stringify([deps.repository, pull.number, pull.headSha, parsed.data.body]))}`;
  const result = await deliverGithubOperation(deps, key, {
    type: "issue.comment",
    repo: deps.repository,
    issueNumber: pull.number,
    body: parsed.data.body,
  });
  return result.kind === "failed"
    ? refuse(result.code)
    : { ok: true as const, status: result.kind, operationKey: key };
}
