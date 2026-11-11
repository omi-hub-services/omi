import { z } from "zod";
import { githubIdSchema } from "../../application/contracts/project-config.js";
import {
  inspectedProjectSchema,
  projectLocatorSchema,
  projectOwnerSchema,
} from "../../application/contracts/project-initialization.js";
import type {
  InspectedProject,
  ProjectOwner,
} from "../../application/contracts/project-initialization.js";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";
import type { GithubProjectReader } from "../../application/ports/github-project-reader.js";
import type { GithubRestClient } from "./github-rest-client.js";

const ownerQuery = `query($login: String!) {
  repositoryOwner(login: $login) { id login __typename }
}`;
const projectQuery = `query($login: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $login) {
    id login __typename
    ... on Organization { projectV2(number: $number) { ...ProjectFields } }
    ... on User { projectV2(number: $number) { ...ProjectFields } }
  }
}
fragment ProjectFields on ProjectV2 {
  id number title
  fields(first: 100, after: $after) {
    nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const ownerWire = z.object({
  id: githubIdSchema,
  login: projectOwnerSchema.shape.login,
  __typename: projectOwnerSchema.shape.type,
});
const pageSchema = z.object({
  repositoryOwner: ownerWire
    .extend({
      projectV2: z
        .object({
          id: githubIdSchema,
          number: z.number().int().positive(),
          title: z.string().max(1024),
          fields: z.object({
            nodes: z.array(
              z.object({
                id: githubIdSchema,
                name: z.string().max(1024),
                dataType: z.string().regex(/^[A-Z][A-Z_]{0,63}$/),
                options: z
                  .array(z.object({ id: githubIdSchema, name: z.string().max(1024) }))
                  .optional(),
              }),
            ),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

/** Refuse partial GraphQL data even when HTTP succeeded; never echo remote error messages. */
export async function readGraphql(
  client: GithubRestClient,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const result = await client.queryGraphql(query, variables);
  if (result.kind !== "ok") throw new ProjectInitializationError(result.code);
  const envelope = z
    .object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() })
    .safeParse(result.json);
  if (!envelope.success) throw new ProjectInitializationError("INVALID_RESPONSE");
  if ((envelope.data.errors?.length ?? 0) > 0)
    throw new ProjectInitializationError("GRAPHQL_ERRORS");
  return envelope.data.data;
}

const toOwner = (wire: z.infer<typeof ownerWire>): ProjectOwner => ({
  id: wire.id,
  login: wire.login,
  type: wire.__typename,
});

/** Org/user discovery and complete cursor-paginated field snapshots over the existing gh client. */
export function createGithubProjectReader(
  client: GithubRestClient,
  maxPages = 20,
): GithubProjectReader {
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new RangeError("maxPages must be positive");
  return {
    async owner(login) {
      projectOwnerSchema.shape.login.parse(login);
      const response = z
        .object({ repositoryOwner: ownerWire.nullable() })
        .safeParse(await readGraphql(client, ownerQuery, { login }));
      if (!response.success) throw new ProjectInitializationError("INVALID_RESPONSE");
      if (response.data.repositoryOwner === null)
        throw new ProjectInitializationError("OWNER_NOT_FOUND");
      return toOwner(response.data.repositoryOwner);
    },
    async inspect(input) {
      const locator = projectLocatorSchema.parse(input);
      let after: string | null = null;
      const cursors = new Set<string>();
      let snapshot: InspectedProject | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const parsed = pageSchema.safeParse(
          await readGraphql(client, projectQuery, {
            login: locator.owner,
            number: locator.number,
            after,
          }),
        );
        if (!parsed.success) throw new ProjectInitializationError("INVALID_RESPONSE");
        const owner = parsed.data.repositoryOwner;
        const project = owner?.projectV2;
        if (owner === null || project === null || project === undefined)
          throw new ProjectInitializationError("PROJECT_NOT_FOUND");
        if (
          snapshot !== undefined &&
          (snapshot.id !== project.id ||
            snapshot.owner.id !== owner.id ||
            snapshot.number !== project.number)
        )
          throw new ProjectInitializationError("PROJECT_CHANGED_DURING_READ");
        const fields = project.fields.nodes.map((field) => {
          if (field.dataType === "SINGLE_SELECT" && field.options === undefined)
            throw new ProjectInitializationError("INVALID_RESPONSE");
          return { ...field, options: field.options ?? [] };
        });
        snapshot = {
          id: project.id,
          number: project.number,
          title: project.title,
          owner: toOwner(owner),
          fields: [...(snapshot?.fields ?? []), ...fields],
        };
        if (!project.fields.pageInfo.hasNextPage) return inspectedProjectSchema.parse(snapshot);
        after = project.fields.pageInfo.endCursor;
        if (after === null || after === "" || cursors.has(after))
          throw new ProjectInitializationError("INVALID_PAGINATION");
        cursors.add(after);
      }
      throw new ProjectInitializationError("PAGINATION_LIMIT");
    },
  };
}
