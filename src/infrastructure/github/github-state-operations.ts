import { z } from "zod";
import type { GithubOperation } from "../../application/contracts/github-operation.js";
import type { LookupOutcome, SendOutcome } from "../../application/ports/github-remote.js";
import { writeOutcome } from "./github-rest-client.js";
import type { GithubRestClient } from "./github-rest-client.js";

/**
 * Outbox operations that change the state of an existing Issue instead of creating a body
 * (ADR-0025 decision 3 covers created bodies). They cannot carry a marker: the Issue body may
 * change only in its Acceptance criteria section. Their read-back is the remote state itself,
 * which is at least as strong as a marker: the Issue body is the target body, the Issue is closed.
 * `pull_request.merge` is the other state operation; it lives in `github-pull-merge.ts`.
 */
export type StateOperation = Extract<
  GithubOperation,
  { type: "issue.update_body" | "issue.close" }
>;

export function isStateOperation(operation: GithubOperation): operation is StateOperation {
  return operation.type === "issue.update_body" || operation.type === "issue.close";
}

const issueState = z.looseObject({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  body: z.string().nullable(),
});

const issuePath = (repo: string, number: number): string =>
  `repos/${repo}/issues/${String(number)}`;

export async function sendStateOperation(
  client: GithubRestClient,
  operation: StateOperation,
): Promise<SendOutcome> {
  switch (operation.type) {
    case "issue.update_body": {
      // GitHub has no conditional Issue update, so the body is compared right before the write.
      const current = await readIssue(client, operation.repo, operation.issueNumber);
      if (current.kind !== "ok") return { kind: "rejected_retryable", code: current.code };
      const body = current.issue.body ?? "";
      if (body === operation.body) {
        return { kind: "succeeded", remoteIdentity: bodyIdentity(operation) };
      }
      if (body !== operation.fromBody)
        return { kind: "rejected_final", code: "ISSUE_BODY_CHANGED" };
      const result = await client.request({
        method: "PATCH",
        path: issuePath(operation.repo, operation.issueNumber),
        body: { body: operation.body },
      });
      return writeOutcome(result, (json) =>
        issueState.safeParse(json).success ? bodyIdentity(operation) : undefined,
      );
    }
    case "issue.close": {
      const result = await client.request({
        method: "PATCH",
        path: issuePath(operation.repo, operation.issueNumber),
        body: { state: "closed", state_reason: "completed" },
      });
      return writeOutcome(result, (json) => {
        const parsed = issueState.safeParse(json);
        return parsed.success && parsed.data.state === "closed"
          ? closeIdentity(operation.repo, operation.issueNumber)
          : undefined;
      });
    }
  }
}

export async function lookupStateOperation(
  client: GithubRestClient,
  operation: StateOperation,
): Promise<LookupOutcome> {
  const current = await readIssue(client, operation.repo, operation.issueNumber);
  if (current.kind !== "ok") return { kind: "unavailable", code: current.code };
  if (operation.type === "issue.update_body") {
    return (current.issue.body ?? "") === operation.body
      ? { kind: "found", remoteIdentity: bodyIdentity(operation) }
      : { kind: "absent" };
  }
  return current.issue.state === "closed"
    ? { kind: "found", remoteIdentity: closeIdentity(operation.repo, operation.issueNumber) }
    : { kind: "absent" };
}

async function readIssue(
  client: GithubRestClient,
  repo: string,
  number: number,
): Promise<
  | { readonly kind: "ok"; readonly issue: z.infer<typeof issueState> }
  | { readonly kind: "failed"; readonly code: string }
> {
  const result = await client.request({ method: "GET", path: issuePath(repo, number) });
  if (result.kind !== "ok") return { kind: "failed", code: result.code };
  const parsed = issueState.safeParse(result.json);
  if (!parsed.success || parsed.data.number !== number) {
    return { kind: "failed", code: "INVALID_RESPONSE" };
  }
  return { kind: "ok", issue: parsed.data };
}

const bodyIdentity = (operation: { repo: string; issueNumber: number }): string =>
  `issue_body:${operation.repo}#${String(operation.issueNumber)}`;
const closeIdentity = (repo: string, number: number): string =>
  `issue_closed:${repo}#${String(number)}`;
