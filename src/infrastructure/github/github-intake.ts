import { z } from "zod";
import type { ProjectLocator } from "../../application/contracts/project-initialization.js";
import { IntakeError } from "../../application/ports/github-intake.js";
import type {
  CreateTaskRequest,
  GithubIntake,
  IntakeIssue,
} from "../../application/ports/github-intake.js";
import {
  ProjectInitializationError,
  type GithubProjectReader,
} from "../../application/ports/github-project-reader.js";
import { SET_FIELD_MUTATION, writeGraphql } from "./github-graphql-write.js";
import { readGraphql } from "./github-project-reader.js";
import type { GithubRestClient } from "./github-rest-client.js";

export interface GithubIntakeDeps {
  readonly client: GithubRestClient;
  readonly projects: GithubProjectReader;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly project: ProjectLocator;
}

const MAX_ITEM_PAGES = 200;
const planKeysQuery = `query ProjectPlanKeys($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 {
    items(first: 100, after: $after) {
      nodes { planKey: fieldValueByName(name: "Plan Key") { ... on ProjectV2ItemFieldTextValue { text } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const addItemMutation = `mutation AddItem($project: ID!, $issue: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $issue }) { item { id } }
}`;

const restIssue = z.object({
  number: z.number().int().positive(),
  id: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  pull_request: z.unknown().optional(),
});
const restMilestone = z.object({ number: z.number().int().positive(), title: z.string() });
const created = z.object({
  number: z.number().int().positive(),
  id: z.number().int().positive(),
  node_id: z.string().min(1),
});
const planKeysPage = z.object({
  node: z.object({
    items: z.object({
      nodes: z.array(z.object({ planKey: z.object({ text: z.string().optional() }).nullable() })),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});
const addedItem = z.object({
  addProjectV2ItemById: z.object({ item: z.object({ id: z.string() }) }),
});

/** Reads and writes the GitHub state behind `createIssueFromSpec`. Reads are complete or throw. */
export function createGithubIntake(deps: GithubIntakeDeps): GithubIntake {
  const slug = `${deps.repository.owner}/${deps.repository.name}`;

  async function list<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const out: T[] = [];
    const result = await deps.client.readPages(path, (page) => {
      const parsed = z.array(schema).safeParse(page);
      if (!parsed.success) return "invalid";
      out.push(...parsed.data);
      return "continue";
    });
    if (result.kind !== "complete")
      throw new IntakeError(result.kind === "failed" ? result.code : "INCOMPLETE_LISTING");
    return out;
  }

  async function projectPlanKeys(projectId: string): Promise<(string | null)[]> {
    const keys: (string | null)[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
      let data: unknown;
      try {
        data = await readGraphql(deps.client, planKeysQuery, { id: projectId, after });
      } catch (error) {
        if (error instanceof ProjectInitializationError) throw new IntakeError(error.code);
        throw error;
      }
      const parsed = planKeysPage.safeParse(data);
      if (!parsed.success) throw new IntakeError("INVALID_RESPONSE");
      keys.push(...parsed.data.node.items.nodes.map((n) => n.planKey?.text ?? null));
      const info = parsed.data.node.items.pageInfo;
      if (!info.hasNextPage) return keys;
      after = info.endCursor;
      if (after === null || after === "") throw new IntakeError("INVALID_PAGINATION");
    }
    throw new IntakeError("PAGINATION_LIMIT");
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const result = await deps.client.request({ method: "POST", path, body });
    if (result.kind !== "ok") throw new IntakeError(result.code);
    return result.json;
  }

  async function mutate(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const result = await writeGraphql(deps.client, query, variables);
    if (!result.ok) throw new IntakeError(result.code);
    return result.data;
  }

  return {
    async snapshot() {
      let project;
      try {
        project = await deps.projects.inspect(deps.project);
      } catch (error) {
        if (error instanceof ProjectInitializationError) throw new IntakeError(error.code);
        throw error;
      }
      // `state=all` includes closed Issues; pull requests share the endpoint and are dropped.
      const issues: IntakeIssue[] = (
        await list(`repos/${slug}/issues?state=all&per_page=100`, restIssue)
      )
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => ({
          number: issue.number,
          id: issue.id,
          title: issue.title,
          body: issue.body ?? "",
        }));
      return {
        projectId: project.id,
        fields: project.fields,
        issues,
        projectPlanKeys: await projectPlanKeys(project.id),
        milestones: await list(`repos/${slug}/milestones?state=all&per_page=100`, restMilestone),
      };
    },

    async createTask(request: CreateTaskRequest) {
      const issue = created.safeParse(
        await post(`repos/${slug}/issues`, {
          title: request.title,
          body: request.body,
          milestone: request.milestoneNumber,
        }),
      );
      if (!issue.success) throw new IntakeError("INVALID_RESPONSE");
      const added = addedItem.safeParse(
        await mutate(addItemMutation, { project: request.projectId, issue: issue.data.node_id }),
      );
      if (!added.success) throw new IntakeError("INVALID_RESPONSE");
      for (const field of request.fields) {
        await mutate(SET_FIELD_MUTATION, {
          project: request.projectId,
          item: added.data.addProjectV2ItemById.item.id,
          field: field.fieldId,
          value: "text" in field ? { text: field.text } : { singleSelectOptionId: field.optionId },
        });
      }
      await post(`repos/${slug}/issues/${String(request.epic.number)}/sub_issues`, {
        sub_issue_id: issue.data.id,
      });
      for (const blocker of request.blockedBy) {
        await post(`repos/${slug}/issues/${String(issue.data.number)}/dependencies/blocked_by`, {
          issue_id: blocker.id,
        });
      }
      return { number: issue.data.number };
    },
  };
}
