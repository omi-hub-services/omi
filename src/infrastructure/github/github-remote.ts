import { z } from "zod";
import type { GithubOperation } from "../../application/contracts/github-operation.js";
import type {
  GithubRemote,
  LookupOutcome,
  LookupRequest,
  SendOutcome,
  SendRequest,
} from "../../application/ports/github-remote.js";
import { hasOperationMarker, operationMarker } from "../../domain/delivery/operation-marker.js";
import type { GithubRestClient, PageVisit } from "./github-rest-client.js";
import { lookupProjectCopy, sendProjectCopy } from "./github-project-copy.js";

/**
 * GitHub side effects of the outbox, over the REST client. Every created Issue, comment or PR
 * carries the operation marker in its body; the read-back lists the same collection and looks for
 * that marker (architecture.md §11). Listings are plain REST collections, not the search index,
 * because search is eventually consistent and a lagging index would read as "absent".
 */
export function createGithubRemote(client: GithubRestClient): GithubRemote {
  return {
    async send(request: SendRequest): Promise<SendOutcome> {
      if (request.operation.type === "project.copy") {
        return sendProjectCopy(client, request.operation, request.operationKey);
      }
      const marker = operationMarker(request.operationKey);
      const call = writeCall(request.operation, marker);
      const result = await client.request({
        method: "POST",
        path: call.path,
        body: call.body,
      });
      switch (result.kind) {
        case "ok": {
          const parsed = call.identity.safeParse(result.json);
          // The write happened; without an id the marker read-back will find and record it.
          return parsed.success
            ? { kind: "succeeded", remoteIdentity: call.format(parsed.data) }
            : { kind: "outcome_unknown", code: "INVALID_RESPONSE" };
        }
        case "rejected":
          return result.retryable
            ? {
                kind: "rejected_retryable",
                code: result.code,
                ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
              }
            : { kind: "rejected_final", code: result.code };
        case "unknown":
        case "unavailable":
          return { kind: "outcome_unknown", code: result.code };
      }
    },

    async lookup(request: LookupRequest): Promise<LookupOutcome> {
      if (request.operation.type === "project.copy") {
        return lookupProjectCopy(client, request.operation, request.operationKey);
      }
      const scan = listing(request.operation, request.operationKey, request.notBefore);
      let found: string | undefined;
      const pages = await client.readPages(scan.path, (page): PageVisit => {
        const items = z.array(z.looseObject({})).safeParse(page);
        if (!items.success) return "invalid";
        for (const item of items.data) {
          const identity = scan.match(item);
          if (identity !== undefined) {
            found = identity;
            return "stop";
          }
        }
        return "continue";
      });
      if (found !== undefined) return { kind: "found", remoteIdentity: found };
      // Absent only when the whole listing was read: a partial scan proves nothing.
      return pages.kind === "complete"
        ? { kind: "absent" }
        : { kind: "unavailable", code: pages.kind === "failed" ? pages.code : "SCAN_STOPPED" };
    },
  };
}

const withMarker = (body: string, marker: string): string =>
  body === "" ? marker : `${body}\n\n${marker}`;

const idResponse = z.looseObject({ id: z.number().int().positive() });
const numberResponse = z.looseObject({ number: z.number().int().positive() });

interface WriteCall {
  readonly path: string;
  readonly body: unknown;
  readonly identity: z.ZodType<{ id: number } | { number: number }>;
  readonly format: (response: { id: number } | { number: number }) => string;
}

function writeCall(
  operation: Exclude<GithubOperation, { type: "project.copy" }>,
  marker: string,
): WriteCall {
  switch (operation.type) {
    case "issue.comment":
      return {
        path: `repos/${operation.repo}/issues/${String(operation.issueNumber)}/comments`,
        body: { body: withMarker(operation.body, marker) },
        identity: idResponse,
        format: (r) => `issue_comment:${operation.repo}:${String("id" in r ? r.id : "")}`,
      };
    case "issue.create":
      return {
        path: `repos/${operation.repo}/issues`,
        body: {
          title: operation.title,
          body: withMarker(operation.body, marker),
          ...(operation.labels === undefined ? {} : { labels: operation.labels }),
        },
        identity: numberResponse,
        format: (r) => `issue:${operation.repo}#${String("number" in r ? r.number : "")}`,
      };
    case "pull_request.create":
      return {
        path: `repos/${operation.repo}/pulls`,
        body: {
          title: operation.title,
          head: operation.head,
          base: operation.base,
          body: withMarker(operation.body, marker),
        },
        identity: numberResponse,
        format: (r) => `pull_request:${operation.repo}#${String("number" in r ? r.number : "")}`,
      };
  }
}

interface Listing {
  readonly path: string;
  /** The remote identity when this item carries the marker, otherwise `undefined`. */
  readonly match: (item: Record<string, unknown>) => string | undefined;
}

/** Local and remote clocks differ a little; read back from slightly before the intent. */
const CLOCK_SKEW_MS = 5 * 60_000;

function listing(
  operation: Exclude<GithubOperation, { type: "project.copy" }>,
  operationKey: string,
  notBefore: string,
): Listing {
  const since = encodeURIComponent(new Date(Date.parse(notBefore) - CLOCK_SKEW_MS).toISOString());
  const bodyHasMarker = (item: Record<string, unknown>): boolean =>
    typeof item["body"] === "string" && hasOperationMarker(item["body"], operationKey);
  switch (operation.type) {
    case "issue.comment":
      return {
        path: `repos/${operation.repo}/issues/${String(operation.issueNumber)}/comments?per_page=100&since=${since}`,
        match: (item) => {
          const id = item["id"];
          return bodyHasMarker(item) && typeof id === "number"
            ? `issue_comment:${operation.repo}:${String(id)}`
            : undefined;
        },
      };
    case "issue.create":
      return {
        path: `repos/${operation.repo}/issues?state=all&sort=created&direction=desc&per_page=100&since=${since}`,
        match: (item) => {
          const number = item["number"];
          // The issues listing also returns pull requests; those are not this operation.
          return !("pull_request" in item) && bodyHasMarker(item) && typeof number === "number"
            ? `issue:${operation.repo}#${String(number)}`
            : undefined;
        },
      };
    case "pull_request.create": {
      const owner = operation.repo.split("/")[0] ?? "";
      return {
        path: `repos/${operation.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${operation.head}`)}&base=${encodeURIComponent(operation.base)}&per_page=100`,
        match: (item) => {
          const number = item["number"];
          return bodyHasMarker(item) && typeof number === "number"
            ? `pull_request:${operation.repo}#${String(number)}`
            : undefined;
        },
      };
    }
  }
}
