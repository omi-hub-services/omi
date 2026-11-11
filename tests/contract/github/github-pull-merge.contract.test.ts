import { describe, expect, it } from "vitest";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { FakeGithub } from "./fake-github.ts";

async function setup() {
  const github = new FakeGithub();
  const remote = createGithubRemote(
    createGithubRestClient({
      transport: github,
      now: Date.now,
      random: () => 0,
      sleep: () => Promise.resolve(),
      policy: { maxTries: 1 },
    }),
  );
  await remote.send({
    operationKey: "pr:1",
    operation: {
      type: "pull_request.create",
      repo: "acme/app",
      head: "task/omi-027",
      base: "develop",
      title: "Recovery",
      body: "Issue: #32",
    },
  });
  const pull = github.pulls[0];
  if (pull === undefined) throw new Error("PR missing");
  const operation = {
    type: "pull_request.merge" as const,
    base: "develop" as const,
    repo: "acme/app",
    pullNumber: pull.number,
    expectedHeadSha: "a".repeat(40),
    prOperationKey: "pr:1",
  };
  return {
    github,
    remote,
    pull,
    operation,
    lookup: () =>
      remote.lookup({ operation, operationKey: "merge:1", notBefore: new Date(0).toISOString() }),
    merge: () => remote.send({ operation, operationKey: "merge:1" }),
  };
}

describe("merge read-back through the existing GitHub outbox adapter", () => {
  it("reads merged state and commit, and a second send makes no PUT", async () => {
    const r = await setup();
    expect(await r.lookup()).toEqual({ kind: "absent" });
    const first = await r.merge();
    // The fake accepts only `merge_method: "merge"`, so a merge commit was asked for.
    expect(r.pull.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first).toMatchObject({
      kind: "succeeded",
      remoteIdentity: `merge:acme/app#${String(r.pull.number)}:${r.pull.mergeCommitSha ?? ""}`,
    });
    expect(await r.merge()).toMatchObject({ kind: "succeeded" });
    expect(r.github.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it.each(["marker", "head", "base", "repository"])(
    "refuses %s identity drift without sending a merge",
    async (fault) => {
      const r = await setup();
      const operation = {
        ...r.operation,
        ...(fault === "marker"
          ? { prOperationKey: "wrong:pr" }
          : fault === "head"
            ? { expectedHeadSha: "c".repeat(40) }
            : fault === "repository"
              ? { repo: "other/app" }
              : {}),
      };
      if (fault === "base") r.github.pulls[0] = { ...r.pull, base: "main" };
      expect(await r.remote.send({ operation, operationKey: "merge:1" })).toMatchObject({
        kind: "outcome_unknown",
      });
      expect(r.github.requests.filter((request) => request.method === "PUT")).toEqual([]);
    },
  );

  it("does not treat a merged flag without a merge commit as evidence", async () => {
    const r = await setup();
    r.pull.merged = true;
    expect(await r.lookup()).toEqual({ kind: "unavailable", code: "MERGE_COMMIT_MISSING" });
  });

  it("retains an unknown outcome when the merge succeeded but the response was lost", async () => {
    const r = await setup();
    r.github.inject({ method: "PUT", effect: { type: "apply_then_fail", failure: "timeout" } });
    expect(await r.merge()).toMatchObject({ kind: "outcome_unknown" });
    expect(await r.lookup()).toMatchObject({ kind: "found" });
    expect(r.github.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it("an unreadable remote remains unavailable and receives no write", async () => {
    const r = await setup();
    r.github.offline = true;
    expect(await r.lookup()).toEqual({ kind: "unavailable", code: "MERGE_READ_FAILED" });
    expect(await r.merge()).toMatchObject({ kind: "outcome_unknown" });
    expect(r.github.requests.filter((request) => request.method === "PUT")).toEqual([]);
  });
});
