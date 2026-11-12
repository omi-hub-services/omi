import {
  TransportError,
  type GithubTransport,
  type HttpMethod,
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
  body: string;
  readonly createdAt: string;
  state?: "open" | "closed";
}
/** The head SHA of a PR whose test did not set one. */
export const DEFAULT_HEAD_SHA = "a".repeat(40);

export interface FakePull extends FakeIssue {
  readonly head: string;
  readonly base: string;
  /** Merge-related state; defaults describe an open, clean, unmerged PR. */
  headSha?: string;
  author?: string;
  draft?: boolean;
  mergeableState?: string;
  merged?: boolean;
  mergeCommitSha?: string | null;
  /** ISO time the PR was merged; only meaningful with `merged`. */
  mergedAt?: string;
}
export interface FakeCheckRun {
  readonly repo: string;
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: string | null;
}
export interface FakeReview {
  readonly repo: string;
  readonly pullNumber: number;
  readonly login: string;
  readonly type: "User" | "Bot";
  readonly state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  readonly commitId: string;
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
  readonly method?: HttpMethod;
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
  deployConclusion: string | null = "success";
  deployStatus = "completed";
  deployProtected = true;
  deployNativeApproved = true;
  deployDigestOverride: string | undefined;
  readonly deployRuns: Record<string, unknown>[] = [];
  readonly deployRecords: Record<string, unknown>[] = [];
  readonly comments: FakeComment[] = [];
  readonly issues: FakeIssue[] = [];
  readonly pulls: FakePull[] = [];
  readonly requests: { readonly method: string; readonly path: string }[] = [];
  /** `<repo>:<branch>` → head commit SHA. */
  readonly branches = new Map<string, string>();
  /** Commit SHA → its repository and parents; merges add their merge commit here. */
  readonly commits = new Map<string, { readonly repo: string; readonly parents: string[] }>();
  readonly checkRuns: FakeCheckRun[] = [];
  /** Commit statuses in creation order (served newest first, like GitHub). */
  readonly statuses: { repo: string; sha: string; context: string; state: string }[] = [];
  readonly reviews: FakeReview[] = [];
  /** `<repo>:<tag>` → commit SHA of a lightweight tag. */
  readonly tags = new Map<string, string>();
  readonly releases: { id: number; repo: string; tag: string; name: string; body: string }[] = [];
  /** `<repo>:<branch>` → active ruleset rules for the branch (GitHub's wire shape). */
  readonly rules = new Map<string, unknown[]>();
  /** Login of the credential the runtime uses. */
  authenticatedLogin = "omi-bot";
  repositoryPermissions = { push: true, admin: true };
  readonly protections = new Map<string, unknown>();
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

    const deployed = this.handleDeployRoutes(request, url);
    if (deployed !== undefined) return deployed;
    const merged = this.handleMergeRoutes(request, url);
    if (merged !== undefined) return merged;

    const repository = /^\/repos\/([^/]+\/[^/]+)$/.exec(route);
    if (request.method === "GET" && repository?.[1] !== undefined) {
      return this.json(200, { full_name: repository[1], permissions: this.repositoryPermissions });
    }
    const protection = /^\/repos\/([^/]+\/[^/]+)\/branches\/([^/]+)\/protection$/.exec(route);
    if (request.method === "GET" && protection?.[1] !== undefined && protection[2] !== undefined) {
      const value = this.protections.get(`${protection[1]}:${decodeURIComponent(protection[2])}`);
      return value === undefined ? this.json(404, {}) : this.json(200, value);
    }

    const detail = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)$/.exec(route);
    if (request.method === "GET" && detail?.[1] !== undefined && detail[3] !== undefined) {
      const [repo, number] = [detail[1], Number(detail[3])];
      if (detail[2] === "pulls") {
        const pull = this.findPull(repo, number);
        return pull === undefined ? this.json(404, {}) : this.json(200, this.pullWire(pull));
      }
      const issue = this.issues.find((i) => i.repo === repo && i.number === number);
      return issue === undefined ? this.json(404, {}) : this.json(200, this.issueWire(issue));
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
        if (
          this.pulls.some(
            (p) =>
              p.repo === repo &&
              p.head === head &&
              p.base === base &&
              (p.state ?? (p.merged === true ? "closed" : "open")) === "open",
          )
        ) {
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
          .filter((p) => {
            // Like GitHub: `state` is open (default), closed or all.
            const wanted = url.searchParams.get("state") ?? "open";
            const state = p.state ?? (p.merged === true ? "closed" : "open");
            return wanted === "all" || wanted === state;
          })
          .map((p) => this.pullWire(p)),
      );
    }

    return this.json(404, { message: "Not Found" });
  }

  private handleDeployRoutes(request: HttpRequest, url: URL): HttpResponse | undefined {
    const route = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(url.pathname);
    const repo = route?.[1];
    const rest = route?.[2];
    if (repo === undefined || rest === undefined) return undefined;
    if (rest.startsWith("environments/"))
      return this.json(200, {
        name: decodeURIComponent(rest.slice(13)),
        can_admins_bypass: false,
        protection_rules: this.deployProtected
          ? [
              {
                type: "required_reviewers",
                prevent_self_review: true,
                reviewers: [{ type: "User", reviewer: { login: "po" } }],
              },
            ]
          : [],
      });
    const workflow = /^actions\/workflows\/([^/]+)\/(dispatches|runs)$/.exec(rest);
    if (workflow?.[1] !== undefined) {
      if (request.method === "POST") {
        const input = payloadOf(request);
        const inputs = input["inputs"] as Record<string, unknown>;
        const id = ++this.nextId;
        this.deployRuns.push({
          id,
          display_title: `omi-deploy:${text(inputs["operation_key"])}`,
          event: "workflow_dispatch",
          head_sha: this.tags.get(`${repo}:${text(input["ref"])}`),
          path: `.github/workflows/${workflow[1]}`,
          run_attempt: 1,
          repository: { full_name: repo },
          actor: { login: this.authenticatedLogin },
          status: this.deployStatus,
          conclusion: this.deployConclusion,
        });
        this.deployRecords.push({
          id: ++this.nextId,
          environment: inputs["environment"],
          sha: this.tags.get(`${repo}:${text(input["ref"])}`),
          payload: {
            operation_key: inputs["operation_key"],
            artifact_digest: this.deployDigestOverride ?? inputs["artifact_digest"],
            run_id: id,
          },
        });
        return this.respond(204, "", {});
      }
      return this.json(200, { workflow_runs: this.deployRuns });
    }
    const run = /^actions\/runs\/(\d+)(\/approvals)?$/.exec(rest);
    if (run?.[1] !== undefined) {
      const found = this.deployRuns.find((r) => r["id"] === Number(run[1]));
      return run[2] === undefined
        ? this.json(200, found)
        : this.json(
            200,
            this.deployNativeApproved
              ? [{ state: "approved", user: { login: "po" }, environments: [{ name: "sandbox" }] }]
              : [],
          );
    }
    if (rest === "deployments") return this.page(url, this.deployRecords);
    if (/^deployments\/\d+\/statuses$/.test(rest))
      return this.json(200, [
        { state: this.deployConclusion === "success" ? "success" : "failure" },
      ]);
    return undefined;
  }

  private pullWire(p: FakePull): unknown {
    return {
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state ?? (p.merged === true ? "closed" : "open"),
      draft: p.draft ?? false,
      merged: p.merged ?? false,
      merge_commit_sha: p.mergeCommitSha ?? null,
      merged_at: p.merged === true ? (p.mergedAt ?? p.createdAt) : null,
      mergeable_state: p.mergeableState ?? "clean",
      user: { login: p.author ?? this.authenticatedLogin },
      html_url: `https://github.com/${p.repo}/pull/${String(p.number)}`,
      head: { ref: p.head, sha: p.headSha ?? DEFAULT_HEAD_SHA, repo: { full_name: p.repo } },
      base: { ref: p.base, repo: { full_name: p.repo } },
    };
  }

  private issueWire(issue: FakeIssue): unknown {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state ?? "open",
      html_url: `https://github.com/${issue.repo}/issues/${String(issue.number)}`,
    };
  }

  private tagWire(tag: string, sha: string): unknown {
    return { ref: `refs/tags/${tag}`, object: { sha, type: "commit" } };
  }

  private releaseWire(r: { id: number; tag: string; name: string; body: string }): unknown {
    return { id: r.id, tag_name: r.tag, name: r.name, body: r.body, draft: false };
  }

  private findPull(repo: string, number: number): FakePull | undefined {
    return this.pulls.find((p) => p.repo === repo && p.number === number);
  }

  /** Routes the merge flow uses: merge, reviews, checks, rules, branches, commits, Issue edits. */
  private handleMergeRoutes(request: HttpRequest, url: URL): HttpResponse | undefined {
    const route = url.pathname;
    if (request.method === "GET" && route === "/user") {
      return this.json(200, { login: this.authenticatedLogin });
    }
    const repoRoute = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(route);
    const repo = repoRoute?.[1];
    const rest = repoRoute?.[2];
    if (repo === undefined || rest === undefined) return undefined;
    const get = request.method === "GET";

    const merge = /^pulls\/(\d+)\/merge$/.exec(rest);
    if (request.method === "PUT" && merge?.[1] !== undefined) {
      return this.merge(repo, Number(merge[1]), payloadOf(request));
    }
    const reviews = /^pulls\/(\d+)\/reviews$/.exec(rest);
    if (get && reviews?.[1] !== undefined) {
      const number = Number(reviews[1]);
      return this.page(
        url,
        this.reviews
          .filter((r) => r.repo === repo && r.pullNumber === number)
          .map((r, index) => ({
            id: index + 1,
            user: { login: r.login, type: r.type },
            state: r.state,
            commit_id: r.commitId,
          })),
      );
    }
    const issue = /^issues\/(\d+)$/.exec(rest);
    if (request.method === "PATCH" && issue?.[1] !== undefined) {
      const found = this.issues.find((i) => i.repo === repo && i.number === Number(issue[1]));
      if (found === undefined) return this.json(404, {});
      const input = payloadOf(request);
      if (typeof input["body"] === "string") found.body = input["body"];
      if (input["state"] === "closed" || input["state"] === "open") found.state = input["state"];
      return this.json(200, this.issueWire(found));
    }
    if (request.method === "POST" && rest === "git/refs") {
      const input = payloadOf(request);
      const ref = /^refs\/tags\/(.+)$/.exec(text(input["ref"]))?.[1];
      const sha = text(input["sha"]);
      if (ref === undefined || !/^[0-9a-f]{40}$/.test(sha))
        return this.json(422, { message: "Validation Failed" });
      if (this.tags.has(`${repo}:${ref}`))
        return this.json(422, { message: "Reference already exists" });
      this.tags.set(`${repo}:${ref}`, sha);
      return this.json(201, this.tagWire(ref, sha));
    }
    if (request.method === "POST" && rest === "releases") {
      const input = payloadOf(request);
      const tag = text(input["tag_name"]);
      if (this.releases.some((r) => r.repo === repo && r.tag === tag))
        return this.json(422, { message: "Validation Failed: already_exists" });
      const created = {
        id: (this.nextId += 1),
        repo,
        tag,
        name: text(input["name"]),
        body: text(input["body"]),
      };
      this.releases.push(created);
      return this.json(201, this.releaseWire(created));
    }
    if (!get) return undefined;

    const tagRef = /^git\/ref\/tags\/(.+)$/.exec(rest);
    if (tagRef?.[1] !== undefined) {
      const name = decodeURIComponent(tagRef[1]);
      const sha = this.tags.get(`${repo}:${name}`);
      return sha === undefined
        ? this.json(404, { message: "Not Found" })
        : this.json(200, this.tagWire(name, sha));
    }
    const releaseByTag = /^releases\/tags\/(.+)$/.exec(rest);
    if (releaseByTag?.[1] !== undefined) {
      const name = decodeURIComponent(releaseByTag[1]);
      const found = this.releases.find((r) => r.repo === repo && r.tag === name);
      return found === undefined
        ? this.json(404, { message: "Not Found" })
        : this.json(200, this.releaseWire(found));
    }

    const branch = /^branches\/([^/]+)$/.exec(rest);
    if (branch?.[1] !== undefined) {
      const name = decodeURIComponent(branch[1]);
      const sha = this.branches.get(`${repo}:${name}`);
      return sha === undefined
        ? this.json(404, { message: "Branch not found" })
        : this.json(200, { name, commit: { sha } });
    }
    const rules = /^rules\/branches\/([^/]+)$/.exec(rest);
    if (rules?.[1] !== undefined) {
      return this.page(url, this.rules.get(`${repo}:${decodeURIComponent(rules[1])}`) ?? []);
    }
    const checkRuns = /^commits\/([0-9a-f]{40})\/check-runs$/.exec(rest);
    if (checkRuns?.[1] !== undefined) {
      const runs = this.checkRuns
        .filter((c) => c.repo === repo && c.headSha === checkRuns[1])
        .map((c) => ({
          id: c.id,
          name: c.name,
          head_sha: c.headSha,
          status: c.status,
          conclusion: c.conclusion,
        }));
      return this.json(200, { total_count: runs.length, check_runs: runs });
    }
    const statuses = /^commits\/([0-9a-f]{40})\/statuses$/.exec(rest);
    if (statuses?.[1] !== undefined) {
      return this.page(
        url,
        this.statuses
          .filter((s) => s.repo === repo && s.sha === statuses[1])
          .reverse()
          .map((s) => ({ context: s.context, state: s.state })),
      );
    }
    const commit = /^commits\/([0-9a-f]{40})$/.exec(rest);
    if (commit?.[1] !== undefined) {
      const found = this.commits.get(commit[1]);
      return found?.repo !== repo
        ? this.json(404, { message: "No commit found" })
        : this.json(200, { sha: commit[1], parents: found.parents.map((sha) => ({ sha })) });
    }
    const compare = /^compare\/([^.]+)\.\.\.(.+)$/.exec(rest);
    if (compare?.[1] !== undefined && compare[2] !== undefined) {
      const base = this.resolve(repo, decodeURIComponent(compare[1]));
      const head = this.resolve(repo, decodeURIComponent(compare[2]));
      if (base === undefined || head === undefined) return this.json(404, {});
      const status =
        base === head
          ? "identical"
          : this.reaches(head, base)
            ? "ahead"
            : this.reaches(base, head)
              ? "behind"
              : "diverged";
      return this.json(200, { status });
    }
    return undefined;
  }

  /** Merge commit only; refuses like GitHub: moved head 409, unmergeable or protected 405. */
  private merge(repo: string, number: number, input: Record<string, unknown>): HttpResponse {
    const pull = this.findPull(repo, number);
    if (pull === undefined) return this.json(404, { message: "Not Found" });
    const headSha = pull.headSha ?? DEFAULT_HEAD_SHA;
    if (pull.merged === true || (pull.state ?? "open") !== "open" || pull.draft === true) {
      return this.json(405, { message: "Pull Request is not mergeable" });
    }
    if (typeof input["sha"] === "string" && input["sha"] !== headSha) {
      return this.json(409, {
        message: "Head branch was modified. Review and try the merge again.",
      });
    }
    if (input["merge_method"] !== "merge") {
      return this.json(405, { message: "Merge method not allowed" });
    }
    if (!["clean", "has_hooks"].includes(pull.mergeableState ?? "clean")) {
      return this.json(405, { message: "Pull Request is not mergeable" });
    }
    if (this.approvalsOnHead(pull, headSha) < this.requiredApprovals(repo, pull.base)) {
      return this.json(405, { message: "At least 1 approving review is required." });
    }
    const baseKey = `${repo}:${pull.base}`;
    const baseHead = this.branches.get(baseKey);
    const mergeSha = (this.nextId += 1).toString(16).padStart(40, "e");
    this.commits.set(mergeSha, {
      repo,
      parents: baseHead === undefined ? [headSha] : [baseHead, headSha],
    });
    this.branches.set(baseKey, mergeSha);
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.state = "closed";
    return this.json(200, {
      sha: mergeSha,
      merged: true,
      message: "Pull Request successfully merged",
    });
  }

  private requiredApprovals(repo: string, branch: string): number {
    let required = 0;
    for (const rule of this.rules.get(`${repo}:${branch}`) ?? []) {
      const parameters = (rule as { type?: string; parameters?: Record<string, unknown> })
        .parameters;
      const count = parameters?.["required_approving_review_count"];
      if (typeof count === "number") required = Math.max(required, count);
    }
    return required;
  }

  private approvalsOnHead(pull: FakePull, headSha: string): number {
    const latest = new Map<string, FakeReview>();
    for (const review of this.reviews) {
      if (review.repo !== pull.repo || review.pullNumber !== pull.number) continue;
      if (review.state !== "COMMENTED") latest.set(review.login, review);
    }
    const author = pull.author ?? this.authenticatedLogin;
    return [...latest.values()].filter(
      (r) => r.state === "APPROVED" && r.commitId === headSha && r.login !== author,
    ).length;
  }

  private resolve(repo: string, ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    return this.branches.get(`${repo}:${ref}`);
  }

  /** True when `ancestor` is reachable from `from` through recorded parents. */
  private reaches(from: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const sha = queue.shift();
      if (sha === undefined || seen.has(sha)) continue;
      if (sha === ancestor) return true;
      seen.add(sha);
      queue.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
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
