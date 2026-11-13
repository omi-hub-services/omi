import { z } from "zod";
import type { InspectedProject } from "../../../src/application/contracts/project-initialization.ts";
import type {
  GithubTransport,
  HttpRequest,
  HttpResponse,
} from "../../../src/infrastructure/github/github-transport.ts";
import { FakeGithubProjects } from "./fake-github-projects.ts";

export interface BoardIssue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  milestone: string | null;
  blockedBy: number[];
  /** Pretend GitHub knows of more blockers than a page returns. */
  blockersTotal?: number;
}
export interface BoardItem {
  id: string;
  issueNumber: number;
  values: Record<string, string>;
}

const SLUG = "acme/app";
const wire = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) });

/**
 * Stateful in-memory GitHub for the intake and board adapters: repository Issues and milestones
 * over REST with `Link` pagination, one Project with items and field values over GraphQL, and the
 * writes they accept. Project field discovery is answered by the existing `FakeGithubProjects`.
 * Modelled on GitHub's documented shapes, no network.
 */
export class FakeGithubBoard implements GithubTransport {
  readonly issues: BoardIssue[] = [];
  readonly pullRequestNumbers: number[] = [];
  readonly milestones: { number: number; title: string }[] = [];
  readonly items: BoardItem[] = [];
  readonly subIssues: { epic: number; subIssueId: number }[] = [];
  /** Every state-changing request, in order; reads are not listed. */
  readonly writes: string[] = [];
  pageSize = 1;
  readonly project: InspectedProject;
  private readonly projects: FakeGithubProjects;
  private nextNumber = 100;

  constructor(project: InspectedProject) {
    this.project = project;
    this.projects = new FakeGithubProjects([project]);
  }

  addIssue(issue: Partial<BoardIssue> & { number: number }, item?: Record<string, string>): void {
    this.issues.push({
      id: issue.number + 1000,
      title: `Issue ${String(issue.number)}`,
      body: "",
      state: "OPEN",
      milestone: null,
      blockedBy: [],
      ...issue,
    });
    if (item !== undefined)
      this.items.push({
        id: `PVTI_${String(issue.number)}`,
        issueNumber: issue.number,
        values: item,
      });
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    const body = wire.safeParse(request.body);
    // Project field discovery is the existing fake's job; reuse it unchanged.
    if (body.success && body.data.query.includes("repositoryOwner"))
      return this.projects.send(request);
    return Promise.resolve().then(() => this.handle(request));
  }

  private handle(request: HttpRequest): HttpResponse {
    const { method, path } = request;
    if (method === "GET" && path.startsWith(`repos/${SLUG}/issues?`))
      return this.list(path, this.restIssues());
    if (method === "GET" && path.startsWith(`repos/${SLUG}/milestones?`))
      return this.list(path, this.milestones);
    if (method === "POST" && path === `repos/${SLUG}/issues`) return this.createIssue(request.body);
    const sub = /^repos\/acme\/app\/issues\/(\d+)\/sub_issues$/.exec(path);
    if (method === "POST" && sub) {
      const body = z.object({ sub_issue_id: z.number() }).parse(request.body);
      this.writes.push(`sub_issue ${sub[1] ?? ""} <- ${String(body.sub_issue_id)}`);
      this.subIssues.push({ epic: Number(sub[1]), subIssueId: body.sub_issue_id });
      return this.json({});
    }
    const dep = /^repos\/acme\/app\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
    if (method === "POST" && dep) {
      const body = z.object({ issue_id: z.number() }).parse(request.body);
      const blocked = this.issue(Number(dep[1]));
      const blocker = this.issues.find((i) => i.id === body.issue_id);
      if (blocker === undefined) return { status: 422, headers: {}, body: "{}" };
      this.writes.push(`blocked_by ${String(blocked.number)} <- ${String(blocker.number)}`);
      blocked.blockedBy.push(blocker.number);
      return this.json({});
    }
    if (method === "POST" && path === "graphql") return this.graphql(wire.parse(request.body));
    throw new Error(`Unexpected request ${method} ${path}`);
  }

  private issue(number: number): BoardIssue {
    const found = this.issues.find((i) => i.number === number);
    if (found === undefined) throw new Error(`no issue ${String(number)}`);
    return found;
  }

  private restIssues() {
    return [
      ...this.issues.map((i) => ({
        number: i.number,
        id: i.id,
        node_id: `I_${String(i.number)}`,
        title: i.title,
        body: i.body === "" ? null : i.body,
        state: i.state === "OPEN" ? "open" : "closed",
      })),
      ...this.pullRequestNumbers.map((number) => ({
        number,
        id: number + 5000,
        node_id: `PR_${String(number)}`,
        title: "[OMI-900] a pull request",
        body: "<!-- omi-squad:plan-key=OMI-900 -->",
        state: "open",
        pull_request: {},
      })),
    ].sort((a, b) => a.number - b.number);
  }

  private list(path: string, all: readonly unknown[]): HttpResponse {
    const base = path.replace(/&page=\d+$/, "");
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
    const start = (page - 1) * this.pageSize;
    const headers: Record<string, string> =
      start + this.pageSize < all.length
        ? { link: `<https://api.github.com/${base}&page=${String(page + 1)}>; rel="next"` }
        : {};
    return {
      status: 200,
      headers,
      body: JSON.stringify(all.slice(start, start + this.pageSize)),
    };
  }

  private createIssue(raw: unknown): HttpResponse {
    const body = z
      .object({ title: z.string(), body: z.string(), milestone: z.number() })
      .parse(raw);
    const milestone = this.milestones.find((m) => m.number === body.milestone);
    if (milestone === undefined) return { status: 422, headers: {}, body: "{}" };
    const number = this.nextNumber++;
    this.writes.push(`create issue ${String(number)}`);
    this.addIssue({ number, title: body.title, body: body.body, milestone: milestone.title });
    return this.json({ number, id: number + 1000, node_id: `I_${String(number)}` });
  }

  private graphql({ query, variables }: z.infer<typeof wire>): HttpResponse {
    if (query.includes("mutation AddItem")) {
      const node = z.string().parse(variables["issue"]);
      const issue = this.issues.find((i) => `I_${String(i.number)}` === node);
      if (issue === undefined) return this.json({ errors: [{ type: "NOT_FOUND" }] });
      const id = `PVTI_${String(issue.number)}`;
      this.writes.push(`add item ${id}`);
      this.items.push({ id, issueNumber: issue.number, values: {} });
      return this.json({ data: { addProjectV2ItemById: { item: { id } } } });
    }
    if (query.includes("mutation SetField")) {
      const input = z
        .object({
          item: z.string(),
          field: z.string(),
          value: z.object({
            singleSelectOptionId: z.string().optional(),
            text: z.string().optional(),
          }),
        })
        .parse(variables);
      const field = this.project.fields.find((f) => f.id === input.field);
      const item = this.items.find((i) => i.id === input.item);
      if (field === undefined || item === undefined)
        return this.json({ errors: [{ type: "NOT_FOUND" }] });
      const option = field.options.find((o) => o.id === input.value.singleSelectOptionId);
      const value = input.value.text ?? option?.name;
      if (value === undefined) return this.json({ errors: [{ type: "UNPROCESSABLE" }] });
      this.writes.push(`set ${field.name}=${value} on ${item.id}`);
      item.values[field.name] = value;
      return this.json({
        data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } },
      });
    }
    if (query.includes("query ProjectPlanKeys")) {
      const after = Number(variables["after"] ?? 0);
      const nodes = this.items.slice(after, after + this.pageSize).map((i) => ({
        planKey: i.values["Plan Key"] === undefined ? null : { text: i.values["Plan Key"] },
      }));
      return this.json({
        data: { node: { items: { nodes, pageInfo: this.pageInfo(after, this.items.length) } } },
      });
    }
    if (query.includes("query BoardIssue")) {
      const number = z.number().parse(variables["number"]);
      const issue = this.issues.find((i) => i.number === number);
      if (issue === undefined) return this.json({ data: { repository: { issue: null } } });
      const item = this.items.find((i) => i.issueNumber === number);
      return this.json({
        data: {
          repository: {
            issue: {
              ...this.content(issue, query),
              projectItems: {
                nodes:
                  item === undefined
                    ? []
                    : [{ ...this.itemFields(item), project: { id: this.project.id } }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      });
    }
    if (query.includes("query BoardItems")) {
      const after = Number(variables["after"] ?? 0);
      const nodes = this.items.slice(after, after + this.pageSize).map((item) => ({
        ...this.itemFields(item),
        content: this.content(this.issue(item.issueNumber), query),
      }));
      return this.json({
        data: { node: { items: { nodes, pageInfo: this.pageInfo(after, this.items.length) } } },
      });
    }
    throw new Error(`Unexpected query ${query.slice(0, 40)}`);
  }

  private pageInfo(after: number, total: number) {
    const end = Math.min(after + this.pageSize, total);
    return { hasNextPage: end < total, endCursor: String(end) };
  }

  private content(issue: BoardIssue, query: string) {
    // Like GitHub, return at most the `first: N` the query asked for.
    const first = Number(/blockedBy\(first: (\d+)/.exec(query)?.[1] ?? Infinity);
    const nodes = issue.blockedBy
      .slice(0, first)
      .map((n) => ({ number: n, state: this.issue(n).state }));
    return {
      __typename: "Issue",
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: issue.body,
      milestone: issue.milestone === null ? null : { title: issue.milestone },
      blockedBy: { totalCount: issue.blockersTotal ?? issue.blockedBy.length, nodes },
    };
  }

  private itemFields(item: BoardItem) {
    const select = (name: string) =>
      item.values[name] === undefined ? null : { name: item.values[name] };
    return {
      id: item.id,
      status: select("Status"),
      priority: select("Priority"),
      workType: select("Work Type"),
      workflow: select("Workflow"),
      role: select("Role"),
      area: select("Area"),
      planKey: item.values["Plan Key"] === undefined ? null : { text: item.values["Plan Key"] },
    };
  }

  private json(body: unknown): HttpResponse {
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  }
}
