import { z } from "zod";
import { githubIdSchema } from "../../application/contracts/project-config.js";
import type { GithubOperation } from "../../application/contracts/github-operation.js";
import type { LookupOutcome, SendOutcome } from "../../application/ports/github-remote.js";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";
import { operationMarker } from "../../domain/delivery/operation-marker.js";
import { readGraphql } from "./github-project-reader.js";
import type { GithubRestClient } from "./github-rest-client.js";

type ProjectCopy = Extract<GithubOperation, { type: "project.copy" }>;
const copyMutation = `mutation($input: CopyProjectV2Input!) {
  copyProjectV2(input: $input) { projectV2 { id number } }
}`;
const listingQuery = `query($ownerId: ID!, $after: String) {
  node(id: $ownerId) {
    ... on ProjectV2Owner {
      projectsV2(first: 100, after: $after) {
        nodes { id number title }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const identitySchema = z.object({ id: githubIdSchema, number: z.number().int().positive() });
const identity = (project: z.infer<typeof identitySchema>): string =>
  `project:${project.id}:${String(project.number)}`;

/** A visible title marker survives a lost copy response; copyProjectV2 cannot set a body. */
export async function sendProjectCopy(
  client: GithubRestClient,
  operation: ProjectCopy,
  operationKey: string,
): Promise<SendOutcome> {
  const title = `${operation.title} ${operationMarker(operationKey)}`;
  if (title.length > 256) return { kind: "rejected_final", code: "PROJECT_TITLE_TOO_LONG" };
  const result = await client.request({
    method: "POST",
    path: "graphql",
    body: {
      query: copyMutation,
      variables: {
        input: {
          ownerId: operation.ownerId,
          projectId: operation.sourceProjectId,
          title,
          includeDraftIssues: false,
          clientMutationId: operationKey,
        },
      },
    },
  });
  if (result.kind === "rejected")
    return result.retryable
      ? {
          kind: "rejected_retryable",
          code: result.code,
          ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
        }
      : { kind: "rejected_final", code: result.code };
  if (result.kind !== "ok") return { kind: "outcome_unknown", code: result.code };
  const response = z
    .object({
      data: z.object({ copyProjectV2: z.object({ projectV2: identitySchema }) }),
      errors: z.array(z.unknown()).optional(),
    })
    .safeParse(result.json);
  // GraphQL can return partial mutation data with errors: conservatively reconcile it.
  if (!response.success || (response.data.errors?.length ?? 0) > 0)
    return { kind: "outcome_unknown", code: "INVALID_GRAPHQL_RESPONSE" };
  return {
    kind: "succeeded",
    remoteIdentity: identity(response.data.data.copyProjectV2.projectV2),
  };
}

export async function lookupProjectCopy(
  client: GithubRestClient,
  operation: ProjectCopy,
  operationKey: string,
  maxPages = 20,
): Promise<LookupOutcome> {
  const title = `${operation.title} ${operationMarker(operationKey)}`;
  let after: string | null = null;
  const seen = new Set<string>();
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const parsed = z
        .object({
          node: z.object({
            projectsV2: z.object({
              nodes: z.array(identitySchema.extend({ title: z.string() })),
              pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            }),
          }),
        })
        .safeParse(await readGraphql(client, listingQuery, { ownerId: operation.ownerId, after }));
      if (!parsed.success) return { kind: "unavailable", code: "INVALID_RESPONSE" };
      const listing = parsed.data.node.projectsV2;
      const found = listing.nodes.find((project) => project.title === title);
      if (found !== undefined) return { kind: "found", remoteIdentity: identity(found) };
      if (!listing.pageInfo.hasNextPage) return { kind: "absent" };
      after = listing.pageInfo.endCursor;
      if (after === null || after === "" || seen.has(after))
        return { kind: "unavailable", code: "INVALID_PAGINATION" };
      seen.add(after);
    }
    return { kind: "unavailable", code: "PAGINATION_LIMIT" };
  } catch (error) {
    return {
      kind: "unavailable",
      code: error instanceof ProjectInitializationError ? error.code : "READ_FAILED",
    };
  }
}
