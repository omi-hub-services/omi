import { describe, expect, it } from "vitest";
import type { GithubOperation } from "../../../src/application/contracts/github-operation.ts";
import { operationMarker } from "../../../src/domain/delivery/operation-marker.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import {
  createGithubRestClient,
  type RestPolicy,
} from "../../../src/infrastructure/github/github-rest-client.ts";
import { FakeGithub, type FakeGithubOptions, type FaultEffect } from "./fake-github.ts";

const T0 = Date.parse("2026-11-11T08:00:00.000Z");
const NOT_BEFORE = new Date(T0).toISOString();

const COMMENT: GithubOperation = {
  type: "issue.comment",
  repo: "acme/app",
  issueNumber: 7,
  body: "Run finished",
};
const ISSUE: GithubOperation = {
  type: "issue.create",
  repo: "acme/app",
  title: "Follow-up",
  body: "Details",
  labels: ["omi"],
};
const PULL: GithubOperation = {
  type: "pull_request.create",
  repo: "acme/app",
  head: "task/omi-1",
  base: "develop",
  title: "OMI-1",
  body: "Issue: #1",
};

function setup(options: FakeGithubOptions = {}, policy: Partial<RestPolicy> = {}) {
  const clock = { ms: T0 };
  const github = new FakeGithub({ now: () => clock.ms, ...options });
  const sleeps: number[] = [];
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
  return { github, sleeps, clock, remote: createGithubRemote(client) };
}

describe("GitHub remote adapter against the fake GitHub", () => {
  describe("send", () => {
    it("creates a comment with the operation marker after the body", async () => {
      const { github, remote } = setup();
      const outcome = await remote.send({ operation: COMMENT, operationKey: "comment:run-1" });
      expect(github.comments).toHaveLength(1);
      expect(github.comments[0]?.body).toBe(`Run finished\n\n${operationMarker("comment:run-1")}`);
      expect(outcome).toEqual({
        kind: "succeeded",
        remoteIdentity: `issue_comment:acme/app:${String(github.comments[0]?.id)}`,
      });
      expect(github.requests).toEqual([
        { method: "POST", path: "repos/acme/app/issues/7/comments" },
      ]);
    });

    it("creates an Issue and a pull request with the marker and their identities", async () => {
      const { github, remote } = setup();
      const issue = await remote.send({ operation: ISSUE, operationKey: "issue:task-1" });
      const pull = await remote.send({ operation: PULL, operationKey: "create-pr:task-1" });
      expect(github.issues[0]?.body).toContain(operationMarker("issue:task-1"));
      expect(github.pulls[0]?.body).toBe(`Issue: #1\n\n${operationMarker("create-pr:task-1")}`);
      expect(github.pulls[0]).toMatchObject({ head: "task/omi-1", base: "develop" });
      expect(issue).toEqual({
        kind: "succeeded",
        remoteIdentity: `issue:acme/app#${String(github.issues[0]?.number)}`,
      });
      expect(pull).toEqual({
        kind: "succeeded",
        remoteIdentity: `pull_request:acme/app#${String(github.pulls[0]?.number)}`,
      });
    });

    it("writes only the marker when the body is empty", async () => {
      const { github, remote } = setup();
      await remote.send({ operation: { ...ISSUE, body: "" }, operationKey: "issue:empty" });
      expect(github.issues[0]?.body).toBe(operationMarker("issue:empty"));
    });

    it.each([
      ["a refused write (422)", { type: "status", status: 422 }, "rejected_final", "HTTP_422"],
      ["a missing login (401)", { type: "status", status: 401 }, "rejected_final", "AUTH_REQUIRED"],
      [
        "an unknown repository (404)",
        { type: "status", status: 404 },
        "rejected_final",
        "HTTP_404",
      ],
    ] as const)("maps %s to a final refusal", async (_name, effect, kind, code) => {
      const { github, remote } = setup();
      github.inject({ method: "POST", effect });
      expect(await remote.send({ operation: COMMENT, operationKey: "k" })).toEqual({ kind, code });
      expect(github.comments).toEqual([]);
    });

    it("maps a rate limit that is too long to wait for to a retryable refusal with its wait", async () => {
      const { github, remote, sleeps } = setup();
      github.inject({
        method: "POST",
        effect: { type: "status", status: 429, headers: { "retry-after": "600" } },
      });
      expect(await remote.send({ operation: COMMENT, operationKey: "k" })).toEqual({
        kind: "rejected_retryable",
        code: "RATE_LIMITED",
        retryAfterMs: 600_000,
      });
      expect(sleeps).toEqual([]);
      expect(github.comments).toEqual([]);
    });

    it.each([
      ["a timeout", { type: "fail", failure: "timeout" }, "TIMEOUT"],
      ["a broken connection", { type: "fail", failure: "connection" }, "CONNECTION_FAILED"],
      ["a lost response", { type: "apply_then_fail", failure: "timeout" }, "TIMEOUT"],
      ["a gateway error after the write", { type: "apply_then_status", status: 502 }, "HTTP_502"],
      ["a server error", { type: "status", status: 503 }, "HTTP_503"],
    ] as const)(
      "maps %s to an unknown outcome and does not repeat the write",
      async (_name, effect, code) => {
        const { github, remote } = setup();
        github.inject({ method: "POST", effect });
        expect(await remote.send({ operation: COMMENT, operationKey: "k" })).toEqual({
          kind: "outcome_unknown",
          code,
        });
        expect(github.requests.filter((r) => r.method === "POST")).toHaveLength(1);
      },
    );

    it("treats a success without a readable identity as unknown so the read-back records it", async () => {
      const { github, remote } = setup();
      github.inject({ method: "POST", effect: { type: "status", status: 201, body: "not json" } });
      github.inject({ method: "POST", effect: { type: "status", status: 201, body: "{}" } });
      for (const code of ["INVALID_RESPONSE", "INVALID_RESPONSE"]) {
        expect(await remote.send({ operation: COMMENT, operationKey: "k" })).toEqual({
          kind: "outcome_unknown",
          code,
        });
      }
    });

    it("refuses an operation key that cannot form a marker before any request", async () => {
      const { github, remote } = setup();
      await expect(remote.send({ operation: COMMENT, operationKey: "a--b" })).rejects.toThrow(
        RangeError,
      );
      expect(github.requests).toEqual([]);
    });
  });

  describe("lookup", () => {
    const sendAndLookup = async (operation: GithubOperation, key: string) => {
      const ctx = setup();
      await ctx.remote.send({ operation, operationKey: key });
      return {
        ...ctx,
        found: await ctx.remote.lookup({ operation, operationKey: key, notBefore: NOT_BEFORE }),
      };
    };

    it("finds a comment, an Issue and a pull request by their marker", async () => {
      const comment = await sendAndLookup(COMMENT, "comment:run-1");
      expect(comment.found).toEqual({
        kind: "found",
        remoteIdentity: `issue_comment:acme/app:${String(comment.github.comments[0]?.id)}`,
      });
      const issue = await sendAndLookup(ISSUE, "issue:task-1");
      expect(issue.found).toEqual({
        kind: "found",
        remoteIdentity: `issue:acme/app#${String(issue.github.issues[0]?.number)}`,
      });
      const pull = await sendAndLookup(PULL, "create-pr:task-1");
      expect(pull.found).toEqual({
        kind: "found",
        remoteIdentity: `pull_request:acme/app#${String(pull.github.pulls[0]?.number)}`,
      });
    });

    it("reports absent only after reading the whole listing", async () => {
      const { github, remote } = setup();
      github.addComment("acme/app", 7, "unrelated");
      expect(
        await remote.lookup({
          operation: COMMENT,
          operationKey: "comment:run-1",
          notBefore: NOT_BEFORE,
        }),
      ).toEqual({ kind: "absent" });
    });

    it("does not mistake another key, another issue or another repository for the operation", async () => {
      const { github, remote } = setup();
      github.addComment("acme/app", 7, `x ${operationMarker("comment:run-12")}`);
      github.addComment("acme/app", 8, `x ${operationMarker("comment:run-1")}`);
      github.addComment("acme/other", 7, `x ${operationMarker("comment:run-1")}`);
      expect(
        await remote.lookup({
          operation: COMMENT,
          operationKey: "comment:run-1",
          notBefore: NOT_BEFORE,
        }),
      ).toEqual({ kind: "absent" });
    });

    it("reads across pages and stops at the page that holds the marker", async () => {
      const { github, remote } = setup({ maxPageSize: 2 });
      for (let i = 0; i < 5; i += 1) github.addComment("acme/app", 7, `noise ${String(i)}`);
      github.addComment("acme/app", 7, operationMarker("comment:run-1"));
      for (let i = 0; i < 4; i += 1) github.addComment("acme/app", 7, `later ${String(i)}`);

      const found = await remote.lookup({
        operation: COMMENT,
        operationKey: "comment:run-1",
        notBefore: NOT_BEFORE,
      });
      expect(found.kind).toBe("found");
      // 6 items before and including the marker at page size 2: pages 1-3, not the last two.
      expect(github.requests).toHaveLength(3);
      expect(github.requests.map((r) => r.path.match(/[?&]page=(\d+)/)?.[1])).toEqual([
        undefined,
        "2",
        "3",
      ]);
    });

    it("does not match a pull request when looking for an Issue, though both are listed", async () => {
      const { github, remote } = setup();
      await remote.send({ operation: PULL, operationKey: "create-pr:task-1" });
      expect(
        await remote.lookup({
          operation: ISSUE,
          operationKey: "create-pr:task-1",
          notBefore: NOT_BEFORE,
        }),
      ).toEqual({ kind: "absent" });
      expect(github.issues).toEqual([]);
    });

    it("searches pull requests by head and base so another branch's PR is not a match", async () => {
      const { github, remote } = setup();
      await remote.send({
        operation: { ...PULL, head: "task/other" },
        operationKey: "create-pr:task-1",
      });
      expect(
        await remote.lookup({
          operation: PULL,
          operationKey: "create-pr:task-1",
          notBefore: NOT_BEFORE,
        }),
      ).toEqual({ kind: "absent" });
      expect(github.requests.at(-1)?.path).toContain("head=acme%3Atask%2Fomi-1");
    });

    it("asks only for items from shortly before the intent was recorded", async () => {
      const { github, remote } = setup();
      await remote.lookup({ operation: COMMENT, operationKey: "k", notBefore: NOT_BEFORE });
      expect(github.requests[0]?.path).toContain(
        `since=${encodeURIComponent(new Date(T0 - 5 * 60_000).toISOString())}`,
      );
    });

    it.each<[string, FaultEffect, string]>([
      ["a failing second page", { type: "status", status: 503 }, "HTTP_503"],
      ["a refused second page", { type: "status", status: 404 }, "HTTP_404"],
      ["a timeout on the second page", { type: "fail", failure: "timeout" }, "TIMEOUT"],
    ])("is unavailable, never absent, after %s of the listing", async (_name, effect, code) => {
      const { github, remote } = setup({ maxPageSize: 1 }, { maxTries: 2 });
      github.addComment("acme/app", 7, "one");
      github.addComment("acme/app", 7, "two");
      // The first page is read fine and holds no marker; the scan then breaks off.
      github.inject({ method: "GET", pathIncludes: "page=2", times: 99, effect });
      expect(
        await remote.lookup({ operation: COMMENT, operationKey: "k", notBefore: NOT_BEFORE }),
      ).toEqual({ kind: "unavailable", code });
    });

    it("is unavailable when the listing is longer than the page limit", async () => {
      const { github, remote } = setup({ maxPageSize: 1 }, { maxPages: 3 });
      for (let i = 0; i < 5; i += 1) github.addComment("acme/app", 7, `noise ${String(i)}`);
      expect(
        await remote.lookup({ operation: COMMENT, operationKey: "k", notBefore: NOT_BEFORE }),
      ).toEqual({ kind: "unavailable", code: "PAGINATION_LIMIT" });
    });

    it("is unavailable when a page is not a list", async () => {
      const { github, remote } = setup();
      github.inject({ method: "GET", effect: { type: "status", status: 200, body: '{"a":1}' } });
      expect(
        await remote.lookup({ operation: COMMENT, operationKey: "k", notBefore: NOT_BEFORE }),
      ).toEqual({ kind: "unavailable", code: "INVALID_RESPONSE" });
    });
  });
});
