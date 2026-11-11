import {
  TransportError,
  type GithubTransport,
  type HttpRequest,
  type HttpResponse,
  type TransportFailure,
} from "../../../src/infrastructure/github/github-transport.ts";

/**
 * In-memory GitHub for tests: the REST endpoints the outbox uses (issue comments, issues, pull
 * requests), with `Link` pagination, rate-limit headers and fault injection. It implements the
 * transport seam, so adapters run unchanged and no test touches the network.
 *
 * The behaviour is modelled on what GitHub documents and ADR-0015 observed: list endpoints are
 * consistent, `per_page` is honoured up to a maximum, a second open PR for the same head and base
 * is refused with 422, and 403/429 carry `Retry-After` or `X-RateLimit-*` headers.
 */
export interface FakeComment {
  readonly id: number;
  readonly repo: string;
  readonly issueNumber: number;
  readonly body: string;
  readonly createdAt: string;
}
export interface FakeIssue {
  readonly number: number;
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
}
export interface FakePull extends FakeIssue {
  readonly head: string;
  readonly base: string;
  headSha?: string;
  merged?: boolean;
  mergeCommitSha?: string;
}

export type FaultEffect =
  /** Answer with this status and apply nothing. */
  | {
      readonly type: "status";
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  /** Cut the call off before GitHub applied anything. */
  | { readonly type: "fail"; readonly failure: TransportFailure }
  /** GitHub applies the write, then the response is lost. */
  | { readonly type: "apply_then_fail"; readonly failure: TransportFailure }
  /** GitHub applies the write, then a gateway answers with this error status. */
  | { readonly type: "apply_then_status"; readonly status: number };

export interface Fault {
  readonly method?: "GET" | "POST" | "PUT";
  /** The fault only hits requests whose path contains this text. */
  readonly pathIncludes?: string;
  /** How many matching requests it hits; default 1. */
  readonly times?: number;
  readonly effect: FaultEffect;
}

export interface FakeGithubOptions {
  readonly now?: () => number;
  /** Items per page; GitHub's own maximum is 100. */
  readonly maxPageSize?: number;
}

export class FakeGithub implements GithubTransport {
  readonly comments: FakeComment[] = [];
  readonly issues: FakeIssue[] = [];
  readonly pulls: FakePull[] = [];
  readonly requests: { readonly method: string; readonly path: string }[] = [];
  offline = false;
  /** Sent on every response as X-RateLimit-Remaining / -Reset (epoch seconds). */
  rateLimit: { remaining: number; resetEpochSeconds: number } | undefined;
  private readonly faults: { fault: Fault; left: number }[] = [];
  private nextId = 1000;
  private readonly now: () => number;
  private readonly maxPageSize: number;

  constructor(options: FakeGithubOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxPageSize = options.maxPageSize ?? 100;
  }

  inject(fault: Fault): void {
    this.faults.push({ fault, left: fault.times ?? 1 });
  }

  /** Someone else (a person, another tool) writes a comment containing this text. */
  addComment(repo: string, issueNumber: number, body: string): FakeComment {
    return this.createComment(repo, issueNumber, body);
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push({ method: request.method, path: request.path });
    if (this.offline) return Promise.reject(new TransportError("connection"));

    const fault = this.takeFault(request);
    if (fault?.type === "fail") return Promise.reject(new TransportError(fault.failure));
    if (fault?.type === "status") {
      return Promise.resolve(this.respond(fault.status, fault.body ?? "{}", fault.headers ?? {}));
    }

    const response = this.handle(request);
    if (fault?.type === "apply_then_fail") {
      return Promise.reject(new TransportError(fault.failure));
    }
    if (fault?.type === "apply_then_status") {
      return Promise.resolve(this.respond(fault.status, '{"message":"Bad Gateway"}', {}));
    }
    return Promise.resolve(response);
  }

  private takeFault(request: HttpRequest): FaultEffect | undefined {
    const index = this.faults.findIndex(
      ({ fault, left }) =>
        left > 0 &&
        (fault.method === undefined || fault.method === request.method) &&
        (fault.pathIncludes === undefined || request.path.includes(fault.pathIncludes)),
    );
    const entry = this.faults[index];
    if (entry === undefined) return undefined;
    entry.left -= 1;
    return entry.fault.effect;
  }

  private respond(
    status: number,
    body: string,
    headers: Readonly<Record<string, string>>,
  ): HttpResponse {
    const limit =
      this.rateLimit === undefined
        ? {}
        : {
            "x-ratelimit-remaining": String(this.rateLimit.remaining),
            "x-ratelimit-reset": String(this.rateLimit.resetEpochSeconds),
          };
    return { status, headers: { "content-type": "application/json", ...limit, ...headers }, body };
  }

  private json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResponse {
    return this.respond(status, JSON.stringify(value), headers);
  }

  private handle(request: HttpRequest): HttpResponse {
    const url = new URL(request.path, "https://api.github.com/");
    const route = url.pathname;

    const merge = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(route);
    if (request.method === "PUT" && merge?.[1] !== undefined && merge[2] !== undefined) {
      const pull = this.pulls.find((p) => p.repo === merge[1] && p.number === Number(merge[2]));
      if (pull === undefined) return this.json(404, {});
      if (pull.merged === true) return this.json(405, {});
      if (payloadOf(request)["sha"] !== (pull.headSha ?? "a".repeat(40))) return this.json(409, {});
      pull.merged = true;
      pull.mergeCommitSha = "b".repeat(40);
      return this.json(200, { merged: true, sha: pull.mergeCommitSha });
    }
    const detail = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)$/.exec(route);
    if (request.method === "GET" && detail?.[1] !== undefined && detail[3] !== undefined) {
      const [repo, number] = [detail[1], Number(detail[3])];
      const item = (detail[2] === "pulls" ? this.pulls : this.issues).find(
        (candidate) => candidate.repo === repo && candidate.number === number,
      );
      if (item === undefined) return this.json(404, {});
      return this.json(
        200,
        "head" in item
          ? this.pullWire(item as FakePull)
          : {
              number: item.number,
              body: item.body,
              html_url: `https://github.com/${repo}/issues/${String(number)}`,
            },
      );
    }

    const comments = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(route);
    if (comments?.[1] !== undefined && comments[2] !== undefined) {
      const [repo, issueNumber] = [comments[1], Number(comments[2])];
      if (request.method === "POST") {
        const created = this.createComment(repo, issueNumber, bodyOf(request));
        return this.json(201, { id: created.id, body: created.body });
      }
      const since = url.searchParams.get("since");
      return this.page(
        url,
        this.comments
          .filter((c) => c.repo === repo && c.issueNumber === issueNumber)
          .filter((c) => since === null || c.createdAt >= since)
          .map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt })),
      );
    }

    const issues = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(route);
    if (issues?.[1] !== undefined) {
      const repo = issues[1];
      if (request.method === "POST") {
        const input = payloadOf(request);
        const created = this.newIssue(repo, input["title"], input["body"]);
        this.issues.push(created);
        return this.json(201, { number: created.number, title: created.title, body: created.body });
      }
      const since = url.searchParams.get("since");
      // Like GitHub, the issues listing also returns pull requests, flagged by `pull_request`.
      const items = [
        ...this.issues.map((i) => ({ ...i, pull: false })),
        ...this.pulls.map((p) => ({ ...p, pull: true })),
      ]
        .filter((i) => i.repo === repo)
        .filter((i) => since === null || i.createdAt >= since)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number)
        .map((i) => ({
          number: i.number,
          title: i.title,
          body: i.body,
          created_at: i.createdAt,
          ...(i.pull ? { pull_request: { url: "x" } } : {}),
        }));
      return this.page(url, items);
    }

    const pulls = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(route);
    if (pulls?.[1] !== undefined) {
      const repo = pulls[1];
      if (request.method === "POST") {
        const input = payloadOf(request);
        const head = text(input["head"]);
        const base = text(input["base"]);
        if (this.pulls.some((p) => p.repo === repo && p.head === head && p.base === base)) {
          return this.json(422, { message: "Validation Failed: A pull request already exists" });
        }
        const pull: FakePull = {
          ...this.newIssue(repo, input["title"], input["body"]),
          head,
          base,
        };
        this.pulls.push(pull);
        return this.json(201, { number: pull.number, title: pull.title, body: pull.body });
      }
      const head = url.searchParams.get("head");
      const base = url.searchParams.get("base");
      return this.page(
        url,
        this.pulls
          .filter((p) => p.repo === repo)
          .filter((p) => head === null || `${repo.split("/")[0] ?? ""}:${p.head}` === head)
          .filter((p) => base === null || p.base === base)
          .map((p) => this.pullWire(p)),
      );
    }

    return this.json(404, { message: "Not Found" });
  }

  private pullWire(p: FakePull): unknown {
    return {
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.merged === true ? "closed" : "open",
      merged: p.merged ?? false,
      merge_commit_sha: p.mergeCommitSha ?? null,
      html_url: `https://github.com/${p.repo}/pull/${String(p.number)}`,
      head: { ref: p.head, sha: p.headSha ?? "a".repeat(40), repo: { full_name: p.repo } },
      base: { ref: p.base, repo: { full_name: p.repo } },
    };
  }

  private page(url: URL, items: readonly unknown[]): HttpResponse {
    const perPage = Math.min(
      Number(url.searchParams.get("per_page") ?? 30) || 30,
      this.maxPageSize,
    );
    const page = Number(url.searchParams.get("page") ?? 1) || 1;
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers["link"] = `<${next.toString()}>; rel="next", <${next.toString()}>; rel="last"`;
    }
    return this.json(200, slice, headers);
  }

  private createComment(repo: string, issueNumber: number, body: string): FakeComment {
    const comment: FakeComment = {
      id: (this.nextId += 1),
      repo,
      issueNumber,
      body,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.comments.push(comment);
    return comment;
  }

  private newIssue(repo: string, title: unknown, body: unknown): FakeIssue {
    return {
      number: (this.nextId += 1),
      repo,
      title: text(title),
      body: text(body),
      createdAt: new Date(this.now()).toISOString(),
    };
  }
}

function payloadOf(request: HttpRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function bodyOf(request: HttpRequest): string {
  return text(payloadOf(request)["body"]);
}

/** A JSON string field, or "" when the field is absent or not a string. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
