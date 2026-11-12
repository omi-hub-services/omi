import { describe, expect, it } from "vitest";
import { createGithubOpenPulls } from "../../../src/infrastructure/github/github-open-pulls.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import type {
  GithubTransport,
  HttpRequest,
  HttpResponse,
} from "../../../src/infrastructure/github/github-transport.ts";

const SHA = "a".repeat(40);
const pull = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${String(number)}`,
  state: "open",
  draft: false,
  body: `Issue: #${String(number + 100)}`,
  head: { ref: `task/omi-${String(number)}-x`, sha: SHA },
  html_url: `https://github.com/acme/app/pull/${String(number)}`,
  ...overrides,
});

/** Serves `pages` one per request, linking each to the next the way GitHub does. */
function transport(pages: readonly unknown[], requests: HttpRequest[] = []): GithubTransport {
  return {
    send(request): Promise<HttpResponse> {
      requests.push(request);
      const page = Number(/[?&]page=(\d+)/.exec(request.path)?.[1] ?? "1");
      const base = request.path.replace(/&page=\d+$/, "");
      const body = pages[page - 1] ?? [];
      return Promise.resolve({
        status: 200,
        headers:
          page < pages.length
            ? { link: `<https://api.github.com/${base}&page=${String(page + 1)}>; rel="next"` }
            : {},
        body: JSON.stringify(body),
      });
    },
  };
}
const client = (t: GithubTransport) =>
  createGithubRestClient({
    transport: t,
    now: () => 0,
    random: () => 0,
    sleep: () => Promise.resolve(),
  });

describe("createGithubOpenPulls", () => {
  it("lists the open pull requests of the repository, across pages", async () => {
    const requests: HttpRequest[] = [];
    const reader = createGithubOpenPulls(
      client(transport([[pull(1)], [pull(2, { draft: true })]], requests)),
    );
    expect(await reader.listOpen("acme/app")).toEqual([
      {
        number: 1,
        title: "PR 1",
        headRef: "task/omi-1-x",
        headSha: SHA,
        draft: false,
        body: "Issue: #101",
      },
      {
        number: 2,
        title: "PR 2",
        headRef: "task/omi-2-x",
        headSha: SHA,
        draft: true,
        body: "Issue: #102",
      },
    ]);
    expect(requests.map((r) => [r.method, r.path.split("&page")[0]])).toEqual([
      ["GET", "repos/acme/app/pulls?state=open&per_page=100"],
      ["GET", "repos/acme/app/pulls?state=open&per_page=100"],
    ]);
  });

  it("reads a missing body as empty text", async () => {
    const reader = createGithubOpenPulls(client(transport([[pull(1, { body: null })]])));
    expect((await reader.listOpen("acme/app"))[0]?.body).toBe("");
  });

  it("throws on a page of the wrong shape instead of showing fewer PRs", async () => {
    const reader = createGithubOpenPulls(client(transport([[{ number: "x" }]])));
    await expect(reader.listOpen("acme/app")).rejects.toThrow("INVALID_PR_LIST");
  });

  it("throws when GitHub refuses, instead of showing no PRs", async () => {
    const refusing: GithubTransport = {
      send: () => Promise.resolve({ status: 403, headers: {}, body: "{}" }),
    };
    await expect(createGithubOpenPulls(client(refusing)).listOpen("acme/app")).rejects.toThrow();
  });

  it("refuses a repository name that is not owner/name before any request", async () => {
    const requests: HttpRequest[] = [];
    const reader = createGithubOpenPulls(client(transport([[]], requests)));
    await expect(reader.listOpen("acme/app/../../user")).rejects.toThrow("INVALID_REPOSITORY");
    expect(requests).toEqual([]);
  });
});
