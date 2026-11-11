import { z } from "zod";
import { gitShaSchema } from "../../application/contracts/identifiers.js";
import type { GithubOperation } from "../../application/contracts/github-operation.js";
import type { LookupOutcome, SendOutcome } from "../../application/ports/github-remote.js";
import { hasOperationMarker } from "../../domain/delivery/operation-marker.js";
import type { GithubRestClient } from "./github-rest-client.js";

type MergeOperation = Extract<GithubOperation, { type: "pull_request.merge" }>;
const pullSchema = z.looseObject({
  number: z.number().int().positive(),
  body: z.string(),
  merged: z.boolean(),
  head: z.looseObject({ sha: gitShaSchema, repo: z.looseObject({ full_name: z.string() }) }),
  base: z.looseObject({ ref: z.string(), repo: z.looseObject({ full_name: z.string() }) }),
  merge_commit_sha: gitShaSchema.nullable(),
});

/** A merge has no writable body of its own: correlate to the PR's existing operation marker,
 * then read GitHub's merged flag and commit. A closed but unmerged PR is never counted merged.
 */
export async function lookupPullMerge(
  client: GithubRestClient,
  operation: MergeOperation,
): Promise<LookupOutcome> {
  const response = await client.request({
    method: "GET",
    path: `repos/${operation.repo}/pulls/${String(operation.pullNumber)}`,
  });
  if (response.kind !== "ok") return { kind: "unavailable", code: "MERGE_READ_FAILED" };
  const parsed = pullSchema.safeParse(response.json);
  if (!parsed.success) return { kind: "unavailable", code: "MERGE_RESPONSE_INVALID" };
  const pull = parsed.data;
  if (
    pull.number !== operation.pullNumber ||
    pull.head.sha !== operation.expectedHeadSha ||
    pull.head.repo.full_name !== operation.repo ||
    pull.base.repo.full_name !== operation.repo ||
    pull.base.ref !== operation.base ||
    !hasOperationMarker(pull.body, operation.prOperationKey)
  )
    return { kind: "unavailable", code: "MERGE_IDENTITY_MISMATCH" };
  if (!pull.merged) return { kind: "absent" };
  return pull.merge_commit_sha === null
    ? { kind: "unavailable", code: "MERGE_COMMIT_MISSING" }
    : {
        kind: "found",
        remoteIdentity: `merge:${operation.repo}#${String(operation.pullNumber)}:${pull.merge_commit_sha}`,
      };
}

/** The workflow must validate delivery gates before queueing this intent (`mergeTaskPr` does so
 * under the merge lock). Restrict this path to task merges into develop; release merges require
 * the separate PO-approved delivery flow. Reads before the PUT, so a confirmed merge is never sent
 * twice.
 */
export async function sendPullMerge(
  client: GithubRestClient,
  operation: MergeOperation,
): Promise<SendOutcome> {
  const prior = await lookupPullMerge(client, operation);
  if (prior.kind === "found") return { kind: "succeeded", remoteIdentity: prior.remoteIdentity };
  if (prior.kind === "unavailable") return { kind: "outcome_unknown", code: prior.code };
  const response = await client.request({
    method: "PUT",
    path: `repos/${operation.repo}/pulls/${String(operation.pullNumber)}/merge`,
    // A merge commit keeps the reviewed head in history; `sha` is GitHub's head-match guard, so a
    // moved head answers 409 and merges nothing.
    body: { sha: operation.expectedHeadSha, merge_method: "merge" },
  });
  if (response.kind === "rejected")
    return response.retryable
      ? {
          kind: "rejected_retryable",
          code: response.code,
          ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
        }
      : { kind: "rejected_final", code: response.code };
  if (response.kind !== "ok") return { kind: "outcome_unknown", code: response.code };
  // Always read back; a success body is not the durable reconciliation evidence.
  const found = await lookupPullMerge(client, operation);
  return found.kind === "found"
    ? { kind: "succeeded", remoteIdentity: found.remoteIdentity }
    : { kind: "outcome_unknown", code: "MERGE_UNCONFIRMED" };
}
