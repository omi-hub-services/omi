import { z } from "zod";
import { githubIdSchema } from "../../application/contracts/project-config.js";
import { taskIssueSchema } from "../../application/contracts/task-import.js";
import type { TaskIssue, TaskItem } from "../../application/contracts/task-import.js";
import { TaskImportError } from "../../application/ports/github-task-reader.js";
import type { GithubTaskReader } from "../../application/ports/github-task-reader.js";
import type { TaskImportSource } from "../../application/ports/task-import-source.js";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";
import { readGraphql, createGithubProjectReader } from "./github-project-reader.js";
import type { GithubRestClient } from "./github-rest-client.js";

export function createGithubTaskImportSource(client: GithubRestClient): TaskImportSource {
  return {
    async resolve(config, issueNumbers) {
      try {
        const projectId =
          config.project.mapping?.id ??
          (await createGithubProjectReader(client).inspect(config.project)).id;
        const issueIds: string[] = [];
        for (const number of issueNumbers) {
          const response = await client.request({
            method: "GET",
            path: `/repos/${config.repository.owner}/${config.repository.name}/issues/${String(number)}`,
          });
          if (response.kind !== "ok") throw new TaskImportError(response.code);
          const issue = z
            .object({
              number: z.literal(number),
              node_id: githubIdSchema,
              pull_request: z.unknown().optional(),
            })
            .safeParse(response.json);
          if (!issue.success) throw new TaskImportError("INVALID_RESPONSE");
          if (issue.data.pull_request !== undefined)
            throw new TaskImportError("ISSUE_NOT_IMPORTABLE");
          issueIds.push(issue.data.node_id);
        }
        return { projectId, issueIds };
      } catch (error) {
        if (error instanceof ProjectInitializationError) throw new TaskImportError(error.code);
        throw error;
      }
    },
  };
}

const itemQuery = `query TaskItems($id: ID!, $after: String) {
  node(id: $id) { id __typename ... on ProjectV2 {
    items(first: 100, after: $after) {
      totalCount nodes { id isArchived content { __typename ... on Issue { id } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const iterationQuery = `query TaskIterations($id: ID!, $after: String) {
  node(id: $id) { id __typename ... on ProjectV2Item {
    fieldValues(first: 100, after: $after) {
      totalCount nodes { __typename ... on ProjectV2ItemFieldIterationValue {
        iterationId field { ... on ProjectV2IterationField { id } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const issueQuery = `query TaskIssue($id: ID!, $after: String) {
  node(id: $id) { id __typename ... on Issue {
    number title body state updatedAt repository { owner { login } name } milestone { id }
    blockedBy(first: 100, after: $after) {
      totalCount nodes { id } pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(node),
    pageInfo: pageInfoSchema,
  });
const itemWire = z.object({
  id: githubIdSchema,
  isArchived: z.boolean(),
  content: z
    .discriminatedUnion("__typename", [
      z.object({ __typename: z.literal("Issue"), id: githubIdSchema }),
      z.object({ __typename: z.literal("DraftIssue") }),
      z.object({ __typename: z.literal("PullRequest") }),
    ])
    .nullable(),
});
const iterationWire = z.object({
  __typename: z.string(),
  iterationId: githubIdSchema.optional(),
  field: z.object({ id: githubIdSchema }).optional(),
});
const issueWire = z.object({
  id: githubIdSchema,
  __typename: z.literal("Issue"),
  number: taskIssueSchema.shape.number,
  title: taskIssueSchema.shape.title,
  body: taskIssueSchema.shape.body,
  state: taskIssueSchema.shape.state,
  updatedAt: taskIssueSchema.shape.updatedAt,
  repository: z.object({
    owner: z.object({ login: taskIssueSchema.shape.repository.shape.owner }),
    name: taskIssueSchema.shape.repository.shape.name,
  }),
  milestone: z.object({ id: githubIdSchema }).nullable(),
  blockedBy: connection(z.object({ id: githubIdSchema })),
});

/** Complete native blockedBy and Project iteration reads; no body/label dependency parsing. */
export function createGithubTaskReader(client: GithubRestClient, maxPages = 20): GithubTaskReader {
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new RangeError("maxPages must be positive");
  async function pages<T>(
    query: string,
    id: string,
    type: string,
    parse: (node: unknown) => {
      totalCount: number;
      nodes: readonly T[];
      pageInfo: z.infer<typeof pageInfoSchema>;
    },
  ): Promise<T[]> {
    githubIdSchema.parse(id);
    let after: string | null = null;
    let totalCount: number | undefined;
    const cursors = new Set<string>();
    const values: T[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      let data: unknown;
      try {
        data = await readGraphql(client, query, { id, after });
      } catch (error) {
        if (error instanceof ProjectInitializationError) throw new TaskImportError(error.code);
        throw error;
      }
      const envelope = z
        .object({ node: z.object({ id: githubIdSchema, __typename: z.string() }) })
        .safeParse(data);
      if (!envelope.success) throw new TaskImportError("INVALID_RESPONSE");
      if (envelope.data.node.id !== id || envelope.data.node.__typename !== type)
        throw new TaskImportError("REMOTE_IDENTITY_MISMATCH");
      const raw = z.object({ node: z.unknown() }).parse(data).node;
      let result: ReturnType<typeof parse>;
      try {
        result = parse(raw);
      } catch (error) {
        if (error instanceof z.ZodError) throw new TaskImportError("INVALID_RESPONSE");
        throw error;
      }
      if (totalCount !== undefined && totalCount !== result.totalCount)
        throw new TaskImportError("REMOTE_CHANGED_DURING_READ");
      totalCount = result.totalCount;
      values.push(...result.nodes);
      if (!result.pageInfo.hasNextPage) {
        if (values.length !== totalCount) throw new TaskImportError("INCOMPLETE_CONNECTION");
        return values;
      }
      after = result.pageInfo.endCursor;
      if (after === null || after === "" || cursors.has(after))
        throw new TaskImportError("INVALID_PAGINATION");
      cursors.add(after);
    }
    throw new TaskImportError("PAGINATION_LIMIT");
  }
  return {
    async items(projectId) {
      const rawItems = await pages(
        itemQuery,
        projectId,
        "ProjectV2",
        (raw) => z.object({ items: connection(itemWire) }).parse(raw).items,
      );
      const items: TaskItem[] = [];
      for (const item of rawItems) {
        const iterations: TaskItem["iterations"] = [];
        if (item.content?.__typename === "Issue" && !item.isArchived) {
          const fields = await pages(
            iterationQuery,
            item.id,
            "ProjectV2Item",
            (raw) => z.object({ fieldValues: connection(iterationWire) }).parse(raw).fieldValues,
          );
          for (const field of fields) {
            if (field.__typename !== "ProjectV2ItemFieldIterationValue") continue;
            if (field.field === undefined || field.iterationId === undefined)
              throw new TaskImportError("INVALID_RESPONSE");
            if (iterations.some((value) => value.fieldId === field.field?.id))
              throw new TaskImportError("DUPLICATE_ITERATION_FIELD");
            iterations.push({ fieldId: field.field.id, iterationId: field.iterationId });
          }
        }
        items.push({
          id: item.id,
          kind: item.content?.__typename ?? "Redacted",
          issueId: item.content?.__typename === "Issue" ? item.content.id : null,
          archived: item.isArchived,
          iterations,
        });
      }
      return items;
    },
    async issue(issueId) {
      let issue: Omit<TaskIssue, "blockedBy"> | undefined;
      const blockedBy = await pages(issueQuery, issueId, "Issue", (raw) => {
        const wire = issueWire.parse(raw);
        const metadata = {
          id: wire.id,
          number: wire.number,
          repository: { owner: wire.repository.owner.login, name: wire.repository.name },
          title: wire.title,
          body: wire.body,
          state: wire.state,
          updatedAt: wire.updatedAt,
          milestoneId: wire.milestone?.id ?? null,
        };
        if (issue !== undefined && JSON.stringify(issue) !== JSON.stringify(metadata))
          throw new TaskImportError("REMOTE_CHANGED_DURING_READ");
        issue = metadata;
        return wire.blockedBy;
      });
      if (issue === undefined) throw new TaskImportError("INVALID_RESPONSE");
      const ids = blockedBy.map((node) => node.id);
      if (new Set(ids).size !== ids.length) throw new TaskImportError("DUPLICATE_DEPENDENCY");
      return taskIssueSchema.parse({ ...issue, blockedBy: ids });
    },
  };
}
