import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "../../../src/domain/runs/retry-policy.ts";
import {
  createGithubRestClient,
  DEFAULT_REST_POLICY,
  type PageVisit,
  type RestPolicy,
} from "../../../src/infrastructure/github/github-rest-client.ts";
import { FakeGithub, type FakeGithubOptions } from "../../contract/github/fake-github.ts";

const T0 = Date.parse("2026-11-11T08:00:00.000Z");
const COMMENTS = "repos/acme/app/issues/7/comments";

/** A client over the fake GitHub whose `sleep` advances a fake clock, so nothing really waits. */
function setup(options: FakeGithubOptions = {}, policy: Partial<RestPolicy> = {}) {
  const clock = { ms: T0 };
  const sleeps: number[] = [];
  const github = new FakeGithub({ now: () => clock.ms, ...options });
  const client = createGithubRestClient({
    transport: github,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.ms += ms;
      return Promise.resolve();
    },
    now: () => clock.ms,
    random: () => 0,
    policy,
  });
  return { github, client, clock, sleeps };
}

const get = (path: string) => ({ method: "GET", path }) as const;
const post = (body: string) => ({ method: "POST", path: COMMENTS, body: { body } }) as const;

describe("retry and backoff", () => {
  it("retries a read after a server error with exponential backoff and then succeeds", async () => {
    const { github, client, sleeps } = setup();
    github.inject({ method: "GET", times: 2, effect: { type: "status", status: 503 } });

    const result = await client.request(get(COMMENTS));

    expect(result.kind).toBe("ok");
    expect(github.requests).toHaveLength(3);
    // random() is 0, so each wait is the lower half of the exponential step.
    const { backoff } = DEFAULT_REST_POLICY;
    expect(sleeps).toEqual([backoffDelayMs(0, 0, backoff), backoffDelayMs(1, 0, backoff)]);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? Infinity);
  });

  it("retries a read after a timeout, and gives up as unavailable when the budget is spent", async () => {
    const { github, client } = setup({}, { maxTries: 3 });
    github.inject({ method: "GET", times: 99, effect: { type: "fail", failure: "timeout" } });
    expect(await client.request(get(COMMENTS))).toEqual({ kind: "unavailable", code: "TIMEOUT" });
    expect(github.requests).toHaveLength(3);
  });

  it("gives up on a read that keeps failing with a server error", async () => {
    const { github, client } = setup({}, { maxTries: 2 });
    github.inject({ method: "GET", times: 99, effect: { type: "status", status: 502 } });
    expect(await client.request(get(COMMENTS))).toEqual({ kind: "unavailable", code: "HTTP_502" });
    expect(github.requests).toHaveLength(2);
  });

  it("waits at least the Retry-After of a 503 on a read", async () => {
    const { github, client, sleeps } = setup();
    github.inject({
      method: "GET",
      effect: { type: "status", status: 503, headers: { "retry-after": "20" } },
    });
    expect((await client.request(get(COMMENTS))).kind).toBe("ok");
    expect(sleeps).toEqual([20_000]);
  });

  it("does not retry a read that was refused for good", async () => {
    const { github, client, sleeps } = setup();
    github.inject({ method: "GET", effect: { type: "status", status: 404 } });
    expect(await client.request(get(COMMENTS))).toEqual({
      kind: "rejected",
      retryable: false,
      code: "HTTP_404",
    });
    expect(github.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("never repeats a write whose outcome is unknown", async () => {
    for (const effect of [
      { type: "fail", failure: "timeout" },
      { type: "fail", failure: "connection" },
      { type: "status", status: 500 },
      { type: "apply_then_status", status: 504 },
      { type: "apply_then_fail", failure: "timeout" },
    ] as const) {
      const { github, client, sleeps } = setup();
      github.inject({ method: "POST", times: 99, effect });
      expect((await client.request(post("x"))).kind).toBe("unknown");
      expect(github.requests, JSON.stringify(effect)).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });
});

describe("Retry-After and rate limits", () => {
  it("waits exactly the Retry-After of a 429 and then repeats the write, which lands once", async () => {
    const { github, client, sleeps } = setup();
    github.inject({
      method: "POST",
      effect: { type: "status", status: 429, headers: { "retry-after": "7" } },
    });

    const result = await client.request(post("hello"));

    expect(result.kind).toBe("ok");
    expect(sleeps).toEqual([7_000]);
    expect(github.requests).toHaveLength(2);
    expect(github.comments).toHaveLength(1);
  });

  it("treats a 403 with Retry-After as a secondary rate limit, not as a permission error", async () => {
    const { github, client, sleeps } = setup();
    github.inject({
      method: "POST",
      effect: { type: "status", status: 403, headers: { "retry-after": "3" } },
    });
    expect((await client.request(post("x"))).kind).toBe("ok");
    expect(sleeps).toEqual([3_000]);
  });

  it("treats a 403 without hints as a secondary limit when GitHub says so, and waits a minute", async () => {
    const { github, client, sleeps } = setup();
    github.inject({
      method: "POST",
      effect: {
        type: "status",
        status: 403,
        body: '{"message":"You have exceeded a secondary rate limit."}',
      },
    });
    expect((await client.request(post("x"))).kind).toBe("ok");
    expect(sleeps).toEqual([60_000]);
  });

  it("keeps a plain 403 as a final refusal", async () => {
    const { github, client } = setup();
    github.inject({
      method: "POST",
      effect: { type: "status", status: 403, body: '{"message":"Resource not accessible"}' },
    });
    expect(await client.request(post("x"))).toEqual({
      kind: "rejected",
      retryable: false,
      code: "HTTP_403",
    });
    expect(github.requests).toHaveLength(1);
  });

  it("waits until X-RateLimit-Reset after an exhausted primary limit", async () => {
    const { github, client, clock, sleeps } = setup();
    const resetEpochSeconds = (T0 + 30_000) / 1000;
    github.inject({
      method: "POST",
      effect: {
        type: "status",
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpochSeconds),
        },
      },
    });
    expect((await client.request(post("x"))).kind).toBe("ok");
    // The reset second plus a one second margin.
    expect(sleeps).toEqual([31_000]);
    expect(clock.ms).toBe(T0 + 31_000);
  });

  it("holds the next request back when the previous response says the limit is exhausted", async () => {
    const { github, client, sleeps } = setup();
    github.rateLimit = { remaining: 0, resetEpochSeconds: (T0 + 10_000) / 1000 };
    await client.request(get(COMMENTS));
    expect(sleeps).toEqual([]);

    github.rateLimit = { remaining: 4000, resetEpochSeconds: 0 };
    await client.request(get(COMMENTS));
    expect(sleeps).toEqual([11_000]);
    // The request that was held back was still made afterwards.
    expect(github.requests).toHaveLength(2);
  });

  it("hands a wait longer than the inline limit to the caller without sending or sleeping", async () => {
    const { github, client, sleeps } = setup({}, { maxInlineWaitMs: 60_000 });
    github.inject({
      method: "POST",
      effect: { type: "status", status: 429, headers: { "retry-after": "900" } },
    });
    expect(await client.request(post("x"))).toEqual({
      kind: "rejected",
      retryable: true,
      code: "RATE_LIMITED",
      retryAfterMs: 900_000,
    });
    expect(sleeps).toEqual([]);
    expect(github.requests).toHaveLength(1);
    expect(github.comments).toEqual([]);
  });

  it("does not send while the primary limit is exhausted for longer than the inline limit", async () => {
    const { github, client } = setup({}, { maxInlineWaitMs: 60_000 });
    github.rateLimit = { remaining: 0, resetEpochSeconds: (T0 + 600_000) / 1000 };
    await client.request(get(COMMENTS));
    const held = await client.request(post("x"));
    expect(held).toMatchObject({ kind: "rejected", retryable: true, code: "RATE_LIMITED" });
    expect(github.requests).toHaveLength(1);
  });

  it("gives up with a retryable refusal when a write is rate limited on every try", async () => {
    const { github, client } = setup({}, { maxTries: 3 });
    github.inject({
      method: "POST",
      times: 99,
      effect: { type: "status", status: 429, headers: { "retry-after": "1" } },
    });
    expect(await client.request(post("x"))).toMatchObject({
      kind: "rejected",
      retryable: true,
      retryAfterMs: 1_000,
    });
    expect(github.requests).toHaveLength(3);
    expect(github.comments).toEqual([]);
  });

  it("understands Retry-After given as an HTTP date", async () => {
    const { github, client, sleeps } = setup();
    github.inject({
      method: "POST",
      effect: {
        type: "status",
        status: 429,
        headers: { "retry-after": new Date(T0 + 12_000).toUTCString() },
      },
    });
    await client.request(post("x"));
    expect(sleeps).toEqual([12_000]);
  });
});

describe("pagination", () => {
  const seed = (github: FakeGithub, count: number) => {
    for (let i = 0; i < count; i += 1) github.addComment("acme/app", 7, `comment ${String(i)}`);
  };
  const collect =
    (seen: string[]) =>
    (page: unknown): PageVisit => {
      if (!Array.isArray(page)) return "invalid";
      for (const item of page as { body: string }[]) seen.push(item.body);
      return "continue";
    };

  it("reads every page of a listing by following the Link header", async () => {
    const { github, client } = setup({ maxPageSize: 2 });
    seed(github, 5);
    const seen: string[] = [];

    const result = await client.readPages(`${COMMENTS}?per_page=2`, collect(seen));

    expect(result).toEqual({ kind: "complete" });
    expect(seen).toEqual(["comment 0", "comment 1", "comment 2", "comment 3", "comment 4"]);
    expect(github.requests).toHaveLength(3);
  });

  it("honours the server's page size cap even when a larger one is requested", async () => {
    const { github, client } = setup({ maxPageSize: 2 });
    seed(github, 5);
    const seen: string[] = [];
    await client.readPages(`${COMMENTS}?per_page=100`, collect(seen));
    expect(seen).toHaveLength(5);
    expect(github.requests).toHaveLength(3);
  });

  it("stops reading when the visitor says so", async () => {
    const { github, client } = setup({ maxPageSize: 2 });
    seed(github, 7);
    const result = await client.readPages(`${COMMENTS}?per_page=2`, () => "stop");
    expect(result).toEqual({ kind: "stopped" });
    expect(github.requests).toHaveLength(1);
  });

  it("reports an incomplete listing instead of a complete one when a later page fails", async () => {
    const { github, client } = setup({ maxPageSize: 2 }, { maxTries: 2 });
    seed(github, 5);
    github.inject({
      method: "GET",
      pathIncludes: "page=3",
      times: 99,
      effect: { type: "status", status: 500 },
    });
    const seen: string[] = [];
    expect(await client.readPages(`${COMMENTS}?per_page=2`, collect(seen))).toEqual({
      kind: "failed",
      code: "HTTP_500",
    });
    expect(seen).toHaveLength(4);
  });

  it("retries a failed page and carries on", async () => {
    const { github, client } = setup({ maxPageSize: 2 });
    seed(github, 5);
    github.inject({
      method: "GET",
      pathIncludes: "page=2",
      effect: { type: "status", status: 503 },
    });
    const seen: string[] = [];
    expect(await client.readPages(`${COMMENTS}?per_page=2`, collect(seen))).toEqual({
      kind: "complete",
    });
    expect(seen).toHaveLength(5);
  });

  it("stops at the page limit and says the listing is incomplete", async () => {
    const { github, client } = setup({ maxPageSize: 1 }, { maxPages: 4 });
    seed(github, 10);
    expect(await client.readPages(`${COMMENTS}?per_page=1`, collect([]))).toEqual({
      kind: "failed",
      code: "PAGINATION_LIMIT",
    });
    expect(github.requests).toHaveLength(4);
  });

  it("reports a page that is not a list as invalid", async () => {
    const { github, client } = setup();
    github.inject({ method: "GET", effect: { type: "status", status: 200, body: "{}" } });
    expect(await client.readPages(COMMENTS, collect([]))).toEqual({
      kind: "failed",
      code: "INVALID_RESPONSE",
    });
  });

  it("reports a rate-limited listing as RATE_LIMITED", async () => {
    const { github, client } = setup({}, { maxInlineWaitMs: 1 });
    github.inject({
      method: "GET",
      effect: { type: "status", status: 429, headers: { "retry-after": "60" } },
    });
    expect(await client.readPages(COMMENTS, collect([]))).toEqual({
      kind: "failed",
      code: "RATE_LIMITED",
    });
  });
});
