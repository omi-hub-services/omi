import { describe, expect, it } from "vitest";
import type { GithubOperation } from "../../../src/application/contracts/github-operation.ts";
import { createGithubMergeDelivery } from "../../../src/infrastructure/github/github-merge-delivery.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { FakeGithub } from "./fake-github.ts";

const T0 = Date.parse("2026-11-11T08:00:00.000Z");
const REPO = "acme/app";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);

function setup() {
  const github = new FakeGithub({ now: () => T0 });
  github.pulls.push({
    number: 5,
    repo: REPO,
    title: "Task",
    body: "Issue: #4",
    createdAt: new Date(T0).toISOString(),
    head: "task/omi-1",
    base: "develop",
    headSha: HEAD,
    author: "omi-bot",
    mergeCommitSha: OTHER,
  });
  github.issues.push({
    number: 4,
    repo: REPO,
    title: "Task",
    body: "## Acceptance criteria\n- [ ] a",
    createdAt: new Date(T0).toISOString(),
  });
  github.branches.set(`${REPO}:develop`, BASE);
  github.commits.set(BASE, { repo: REPO, parents: [] });
  github.commits.set(HEAD, { repo: REPO, parents: [BASE] });
  const client = createGithubRestClient({
    transport: github,
    now: () => T0,
    random: () => 0,
    sleep: () => Promise.resolve(),
  });
  return {
    github,
    reader: createGithubMergeDelivery(client),
    remote: createGithubRemote(client),
  };
}

const merge = (headSha: string): GithubOperation => ({
  type: "pull_request.merge",
  repo: REPO,
  pullNumber: 5,
  headSha,
  mergeMethod: "merge",
});

describe("GitHub merge reader", () => {
  it("reads an open PR without trusting its test-merge SHA, and reports a draft as draft", async () => {
    const s = setup();
    expect(await s.reader.pull(REPO, 5)).toMatchObject({
      merged: false,
      mergeCommitSha: null,
      headSha: HEAD,
      author: "omi-bot",
      mergeableState: "clean",
    });
    const pull = s.github.pulls[0];
    if (pull !== undefined) Object.assign(pull, { draft: true });
    expect(await s.reader.pull(REPO, 5)).toMatchObject({ mergeableState: "draft" });
    if (pull !== undefined) Object.assign(pull, { draft: false, mergeableState: "brand_new" });
    expect(await s.reader.pull(REPO, 5)).toMatchObject({ mergeableState: "unknown" });
  });

  it("takes the latest run per check name and the newest status per context", async () => {
    const s = setup();
    s.github.checkRuns.push(
      { repo: REPO, id: 2, name: "ci", headSha: HEAD, status: "completed", conclusion: "success" },
      { repo: REPO, id: 1, name: "ci", headSha: HEAD, status: "completed", conclusion: "failure" },
      { repo: REPO, id: 3, name: "lint", headSha: HEAD, status: "in_progress", conclusion: null },
    );
    s.github.statuses.push(
      { repo: REPO, sha: HEAD, context: "legacy", state: "failure" },
      { repo: REPO, sha: HEAD, context: "legacy", state: "success" },
    );
    expect(await s.reader.checks(REPO, HEAD)).toEqual([
      { name: "ci", headSha: HEAD, status: "passed" },
      { name: "lint", headSha: HEAD, status: "pending" },
      { name: "legacy", headSha: HEAD, status: "passed" },
    ]);
  });

  it("reads ruleset requirements and native reviews, and fails closed on an unreadable listing", async () => {
    const s = setup();
    s.github.rules.set(`${REPO}:develop`, [
      { type: "pull_request", parameters: { required_approving_review_count: 2 } },
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci" }] },
      },
      { type: "deletion" },
    ]);
    s.github.reviews.push({
      repo: REPO,
      pullNumber: 5,
      login: "po",
      type: "User",
      state: "APPROVED",
      commitId: HEAD,
    });
    expect(await s.reader.branchRules(REPO, "develop")).toEqual({
      requiredApprovingReviewCount: 2,
      requiredChecks: ["ci"],
    });
    expect(await s.reader.nativeReviews(REPO, 5)).toEqual([
      { actor: "po", actorType: "User", state: "APPROVED", commitSha: HEAD },
    ]);
    s.github.inject({
      method: "GET",
      pathIncludes: "/rules/",
      times: 4,
      effect: { type: "status", status: 502 },
    });
    await expect(s.reader.branchRules(REPO, "develop")).rejects.toThrow("HTTP_502");
  });

  it("tells whether a commit is on a branch", async () => {
    const s = setup();
    expect(await s.reader.branchContains(REPO, "develop", BASE)).toBe(true);
    expect(await s.reader.branchContains(REPO, "develop", HEAD)).toBe(false);
  });
});

describe("GitHub state operations of the outbox", () => {
  it("merges with the head guard and finds the merge again by reading the PR", async () => {
    const s = setup();
    const sent = await s.remote.send({ operation: merge(HEAD), operationKey: "merge-pr:x" });
    const sha = s.github.pulls[0]?.mergeCommitSha ?? "";
    expect(sent).toEqual({
      kind: "succeeded",
      remoteIdentity: `pull_request_merge:${REPO}#5:${sha}`,
    });
    const notBefore = new Date(T0).toISOString();
    expect(await s.remote.lookup({ operation: merge(HEAD), operationKey: "k", notBefore })).toEqual(
      { kind: "found", remoteIdentity: `pull_request_merge:${REPO}#5:${sha}` },
    );
    // A merge at another head is not this operation's effect.
    expect(
      await s.remote.lookup({ operation: merge(OTHER), operationKey: "k", notBefore }),
    ).toEqual({ kind: "absent" });
  });

  it("is refused, applying nothing, when the head moved", async () => {
    const s = setup();
    expect(await s.remote.send({ operation: merge(OTHER), operationKey: "merge-pr:x" })).toEqual({
      kind: "rejected_final",
      code: "HTTP_409",
    });
    expect(s.github.pulls[0]?.merged).toBeUndefined();
  });

  it("updates the Issue body only from the expected body, and closes the Issue", async () => {
    const s = setup();
    const update = (fromBody: string): GithubOperation => ({
      type: "issue.update_body",
      repo: REPO,
      issueNumber: 4,
      fromBody,
      body: "## Acceptance criteria\n- [x] a",
    });
    expect(
      await s.remote.send({ operation: update("edited by someone"), operationKey: "tick" }),
    ).toEqual({ kind: "rejected_final", code: "ISSUE_BODY_CHANGED" });
    expect(s.github.issues[0]?.body).toBe("## Acceptance criteria\n- [ ] a");

    const operation = update("## Acceptance criteria\n- [ ] a");
    expect(await s.remote.send({ operation, operationKey: "tick" })).toMatchObject({
      kind: "succeeded",
    });
    // Sending again after a lost response finds the body already in place.
    expect(await s.remote.send({ operation, operationKey: "tick" })).toMatchObject({
      kind: "succeeded",
    });
    expect(s.github.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);

    const close: GithubOperation = { type: "issue.close", repo: REPO, issueNumber: 4 };
    const notBefore = new Date(T0).toISOString();
    expect(await s.remote.lookup({ operation: close, operationKey: "c", notBefore })).toEqual({
      kind: "absent",
    });
    expect(await s.remote.send({ operation: close, operationKey: "c" })).toMatchObject({
      kind: "succeeded",
    });
    expect(await s.remote.lookup({ operation: close, operationKey: "c", notBefore })).toEqual({
      kind: "found",
      remoteIdentity: `issue_closed:${REPO}#4`,
    });
  });
});
