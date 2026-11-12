import { z } from "zod";
import type { ProjectLocator } from "../../application/contracts/project-initialization.js";
import type { GatedStatus } from "../../application/contracts/task-intake.js";
import {
  ProjectInitializationError,
  type GithubProjectReader,
} from "../../application/ports/github-project-reader.js";
import { TaskBoardError } from "../../application/ports/github-task-board.js";
import type { GithubTaskBoard } from "../../application/ports/github-task-board.js";
import type { PromotionCandidate } from "../../domain/tasks/promotion-policy.js";
import { SET_FIELD_MUTATION, writeGraphql } from "./github-graphql-write.js";
import { readGraphql } from "./github-project-reader.js";
import type { GithubRestClient } from "./github-rest-client.js";

export interface GithubTaskBoardDeps {
  readonly client: GithubRestClient;
  readonly projects: GithubProjectReader;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly project: ProjectLocator;
}

const MAX_ITEM_PAGES = 200;
const select = (alias: string, name: string) =>
  `${alias}: fieldValueByName(name: "${name}") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;
const ITEM_FIELDS = `id
  ${select("status", "Status")}
  ${select("priority", "Priority")}
  ${select("workType", "Work Type")}
  ${select("workflow", "Workflow")}
  ${select("role", "Role")}
  ${select("area", "Area")}
  planKey: fieldValueByName(name: "Plan Key") { ... on ProjectV2ItemFieldTextValue { text } }`;
const ISSUE_FIELDS = `number state body milestone { title }
  blockedBy(first: 50) { totalCount nodes { number state } }`;
const issueQuery = `query BoardIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    ${ISSUE_FIELDS}
    projectItems(first: 50) { nodes { ${ITEM_FIELDS} project { id } } pageInfo { hasNextPage } }
  } }
}`;
const itemsQuery = `query BoardItems($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 {
    items(first: 50, after: $after) {
      nodes { ${ITEM_FIELDS} content { __typename ... on Issue { ${ISSUE_FIELDS} } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;

// A field with no value is null; one of another type is an empty object, so `name`/`text` are optional.
const named = z.object({ name: z.string().optional() }).nullable();
const itemWire = z.object({
  id: z.string().min(1),
  status: named,
  priority: named,
  workType: named,
  workflow: named,
  role: named,
  area: named,
  planKey: z.object({ text: z.string().optional() }).nullable(),
});
const blocker = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED"]),
});
const issueWire = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED"]),
  body: z.string(),
  milestone: z.object({ title: z.string() }).nullable(),
  blockedBy: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(blocker) }),
});
const issueResponse = z.object({
  repository: z.object({
    issue: issueWire
      .extend({
        projectItems: z.object({
          nodes: z.array(itemWire.extend({ project: z.object({ id: z.string() }) })),
          pageInfo: z.object({ hasNextPage: z.boolean() }),
        }),
      })
      .nullable(),
  }),
});
const itemsResponse = z.object({
  node: z.object({
    items: z.object({
      nodes: z.array(
        itemWire.extend({ content: z.object({ __typename: z.string() }).loose().nullable() }),
      ),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});

function candidate(
  issue: z.infer<typeof issueWire>,
  item: z.infer<typeof itemWire>,
): PromotionCandidate {
  return {
    number: issue.number,
    state: issue.state,
    status: item.status?.name ?? null,
    planKey: item.planKey?.text ?? null,
    body: issue.body,
    priority: item.priority?.name ?? null,
    workType: item.workType?.name ?? null,
    workflow: item.workflow?.name ?? null,
    role: item.role?.name ?? null,
    area: item.area?.name ?? null,
    milestone: issue.milestone?.title ?? null,
    blockers: issue.blockedBy.nodes,
    blockersTruncated: issue.blockedBy.totalCount > issue.blockedBy.nodes.length,
  };
}

/** Project items of one repository's tasks, read completely through the existing GitHub client. */
export function createGithubTaskBoard(deps: GithubTaskBoardDeps): GithubTaskBoard {
  async function inspect() {
    try {
      return await deps.projects.inspect(deps.project);
    } catch (error) {
      if (error instanceof ProjectInitializationError) throw new TaskBoardError(error.code);
      throw error;
    }
  }

  async function query<T>(text: string, variables: Record<string, unknown>, schema: z.ZodType<T>) {
    let data: unknown;
    try {
      data = await readGraphql(deps.client, text, variables);
    } catch (error) {
      if (error instanceof ProjectInitializationError) throw new TaskBoardError(error.code);
      throw error;
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new TaskBoardError("INVALID_RESPONSE");
    return parsed.data;
  }

  async function locate(projectId: string, issueNumber: number) {
    const { repository } = await query(
      issueQuery,
      { owner: deps.repository.owner, name: deps.repository.name, number: issueNumber },
      issueResponse,
    );
    if (repository.issue === null) return undefined;
    const item = repository.issue.projectItems.nodes.find((n) => n.project.id === projectId);
    if (item === undefined) {
      if (repository.issue.projectItems.pageInfo.hasNextPage)
        throw new TaskBoardError("INCOMPLETE_PROJECT_ITEMS");
      return undefined;
    }
    return { itemId: item.id, task: candidate(repository.issue, item) };
  }

  return {
    async read(issueNumber) {
      return (await locate((await inspect()).id, issueNumber))?.task;
    },

    async listBacklog() {
      const project = await inspect();
      const backlog: PromotionCandidate[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
        const { node }: z.infer<typeof itemsResponse> = await query(
          itemsQuery,
          { id: project.id, after },
          itemsResponse,
        );
        for (const item of node.items.nodes) {
          if (item.content?.__typename !== "Issue" || item.status?.name !== "Backlog") continue;
          const issue = issueWire.safeParse(item.content);
          if (!issue.success) throw new TaskBoardError("INVALID_RESPONSE");
          backlog.push(candidate(issue.data, item));
        }
        if (!node.items.pageInfo.hasNextPage) return backlog;
        after = node.items.pageInfo.endCursor;
        if (after === null || after === "") throw new TaskBoardError("INVALID_PAGINATION");
      }
      throw new TaskBoardError("PAGINATION_LIMIT");
    },

    async setStatus(issueNumber, status: GatedStatus) {
      const project = await inspect();
      const field = project.fields.find((f) => f.name === "Status");
      const option = field?.options.find((o) => o.name === status);
      if (field === undefined || option === undefined)
        throw new TaskBoardError("STATUS_OPTION_MISSING");
      const found = await locate(project.id, issueNumber);
      if (found === undefined) throw new TaskBoardError("NOT_ON_PROJECT");
      if (found.task.status === status) return;
      const result = await writeGraphql(deps.client, SET_FIELD_MUTATION, {
        project: project.id,
        item: found.itemId,
        field: field.id,
        value: { singleSelectOptionId: option.id },
      });
      if (!result.ok) throw new TaskBoardError(result.code);
    },
  };
}
