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
import { writeOutcome } from "./github-rest-client.js";
import type { GithubRestClient, PageVisit } from "./github-rest-client.js";
import { lookupProjectCopy, sendProjectCopy } from "./github-project-copy.js";
import {
  isStateOperation,
  lookupStateOperation,
  sendStateOperation,
} from "./github-state-operations.js";
import type { StateOperation } from "./github-state-operations.js";

/** Operations that create a body carrying the marker. */
type MarkedOperation = Exclude<GithubOperation, { type: "project.copy" } | StateOperation>;

/**
 * GitHub side effects of the outbox, over the REST client. Every created Issue, comment or PR
 * carries the operation marker in its body; the read-back lists the same collection and looks for
 * that marker (architecture.md §11). Listings are plain REST collections, not the search index,
 * because search is eventually consistent and a lagging index would read as "absent".
 */
export function createGithubRemote(client: GithubRestClient): GithubRemote {
  return {
    async send(request: SendRequest): Promise<SendOutcome> {
      const operation = request.operation;
      if (operation.type === "project.copy") {
        return sendProjectCopy(client, operation, request.operationKey);
      }
      if (isStateOperation(operation)) return sendStateOperation(client, operation);
      const marker = operationMarker(request.operationKey);
      const call = writeCall(operation, marker);
      const result = await client.request({
        method: "POST",
        path: call.path,
        body: call.body,
      });
      // The write happened; without an id the marker read-back will find and record it.
      return writeOutcome(result, (json) => {
        const parsed = call.identity.safeParse(json);
        return parsed.success ? call.format(parsed.data) : undefined;
      });
    },

    async lookup(request: LookupRequest): Promise<LookupOutcome> {
      const operation = request.operation;
      if (operation.type === "project.copy") {
        return lookupProjectCopy(client, operation, request.operationKey);
      }
      if (isStateOperation(operation)) return lookupStateOperation(client, operation);
      const scan = listing(operation, request.operationKey, request.notBefore);
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

function writeCall(operation: MarkedOperation, marker: string): WriteCall {
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

function listing(operation: MarkedOperation, operationKey: string, notBefore: string): Listing {
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
