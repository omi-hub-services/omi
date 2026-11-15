import { z } from "zod";
import type { InspectedProject } from "../../../src/application/contracts/project-initialization.ts";
import {
  TransportError,
  type GithubTransport,
  type HttpRequest,
  type HttpResponse,
} from "../../../src/infrastructure/github/github-transport.ts";

/** Synthetic GraphQL server modelled on ADR-0015 and GitHub's Projects reference, no network. */
export class FakeGithubProjects implements GithubTransport {
  readonly projects: InspectedProject[] = [];
  readonly requests: { query: string; variables: Record<string, unknown> }[] = [];
  pageSize = 1;
  copyThenTimeout = false;
  nextResponse: HttpResponse | TransportError | undefined;
  repeatCursor = false;
  constructor(projects: readonly InspectedProject[]) {
    this.projects = structuredClone([...projects]);
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    return Promise.resolve().then(() => this.handle(request));
  }

  private handle(request: HttpRequest): HttpResponse {
    if (request.path !== "graphql" || request.method !== "POST")
      throw new Error("Expected GraphQL POST");
    const body = z
      .object({ query: z.string(), variables: z.record(z.string(), z.unknown()) })
      .parse(request.body);
    this.requests.push(body);
    if (this.nextResponse !== undefined) {
      const response = this.nextResponse;
      this.nextResponse = undefined;
      if (response instanceof TransportError) throw response;
      return response;
    }
    const { query, variables } = body;
    if (query.includes("copyProjectV2")) {
      const input = z
        .strictObject({
          ownerId: z.string(),
          projectId: z.string(),
          title: z.string(),
          includeDraftIssues: z.literal(false),
          clientMutationId: z.string(),
        })
        .parse(variables["input"]);
      const template = this.projects.find((project) => project.id === input.projectId);
      const owner = this.projects.find((project) => project.owner.id === input.ownerId)?.owner;
      if (template === undefined || owner === undefined)
        return this.json({ errors: [{ type: "NOT_FOUND", message: "No project" }] });
      const copied: InspectedProject = {
        ...structuredClone(template),
        id: "PVT_copy",
        number: 9,
        title: input.title,
        owner,
        fields: template.fields.map((field) => ({
          ...field,
          id: `copy_${field.id}`,
          options: field.options.map((option) => ({ ...option, id: `copy_${option.id}` })),
        })),
      };
      this.projects.push(copied);
      if (this.copyThenTimeout) {
        this.copyThenTimeout = false;
        throw new TransportError("timeout");
      }
      return this.json({
        data: { copyProjectV2: { projectV2: { id: copied.id, number: copied.number } } },
      });
    }
    if (query.includes("repositoryOwner")) {
      const login = z.string().parse(variables["login"]);
      const owner = this.projects.find(
        (project) => project.owner.login.toLowerCase() === login.toLowerCase(),
      )?.owner;
      if (owner === undefined) return this.json({ data: { repositoryOwner: null } });
      const wire = { id: owner.id, login: owner.login, __typename: owner.type };
      if (!query.includes("projectV2")) return this.json({ data: { repositoryOwner: wire } });
      // Contract checks: neither names nor interpolated user input belong in a field query.
      if (
        !query.includes("... on Organization") ||
        !query.includes("... on User") ||
        !query.includes("... on ProjectV2SingleSelectField") ||
        !query.includes("pageInfo")
      )
        throw new Error("Incomplete Project query");
      const number = z.number().parse(variables["number"]);
      const project = this.projects.find(
        (candidate) => candidate.owner.id === owner.id && candidate.number === number,
      );
      if (project === undefined)
        return this.json({ data: { repositoryOwner: { ...wire, projectV2: null } } });
      const page = this.page(project.fields, variables["after"]);
      return this.json({
        data: {
          repositoryOwner: {
            ...wire,
            projectV2: {
              id: project.id,
              number: project.number,
              title: project.title,
              fields: page,
            },
          },
        },
      });
    }
    if (query.includes("projectsV2")) {
      const ownerId = z.string().parse(variables["ownerId"]);
      const projects = this.projects
        .filter((project) => project.owner.id === ownerId)
        .map(({ id, number, title }) => ({ id, number, title }));
      return this.json({ data: { node: { projectsV2: this.page(projects, variables["after"]) } } });
    }
    throw new Error("Unexpected query");
  }
  private page<T>(items: readonly T[], cursor: unknown) {
    const start = cursor === null || cursor === undefined ? 0 : Number(cursor);
    const end = Math.min(start + this.pageSize, items.length);
    return {
      nodes: items.slice(start, end),
      pageInfo: {
        hasNextPage: end < items.length,
        endCursor: this.repeatCursor ? "0" : String(end),
      },
    };
  }
  private json(body: unknown): HttpResponse {
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  }
}
