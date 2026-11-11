import { describe, expect, it } from "vitest";
import type { Decision } from "../../../src/domain/shared/decision.ts";
import { checkReleaseMerge } from "../../../src/application/use-cases/delivery/check-release-merge.ts";
import { createGithubReleaseMergeReader } from "../../../src/infrastructure/github/github-release-merge.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { FakeGithub } from "./fake-github.ts";

const REPO = "acme/sandbox";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const request = {
  repository: REPO,
  prNumber: 5,
  expectedHeadSha: HEAD,
  poActors: ["po"],
  requiredChecks: ["ci"],
};
function setup() {
  const github = new FakeGithub({ maxPageSize: 1 });
  github.pulls.push({
    number: 5,
    repo: REPO,
    title: "Release",
    body: "Release Issue: #4",
    createdAt: "2026-11-11T00:00:00Z",
    head: "develop",
    base: "main",
    headSha: HEAD,
  });
  github.reviews.push({
    repo: REPO,
    pullNumber: 5,
    login: "po",
    type: "User",
    state: "APPROVED",
    commitId: HEAD,
  });
  github.statuses.push({ repo: REPO, sha: HEAD, context: "ci", state: "success" });
  github.rules.set(`${REPO}:main`, [
    { type: "pull_request", parameters: { required_approving_review_count: 1 } },
  ]);
  github.protections.set(`${REPO}:main`, { enforce_admins: { enabled: true } });
  const reader = createGithubReleaseMergeReader(
    createGithubRestClient({
      transport: github,
      now: () => 0,
      random: () => 0,
      sleep: () => Promise.resolve(),
    }),
  );
  return { github, reader, check: () => checkReleaseMerge(reader, request) };
}
function refused(result: Decision<string>, reason: string) {
  expect(result.allowed).toBe(false);
  if (!result.allowed) expect(result.reasons).toContain(reason);
}

describe("release native approval gate over FakeGithub", () => {
  it("reads the native review of this PR, never writes, and re-reads the head", async () => {
    const s = setup();
    expect(await s.check()).toEqual({ allowed: true });
    expect(s.github.requests.every((r) => r.method === "GET")).toBe(true);
    expect(s.github.requests.filter((r) => r.path.endsWith("/pulls/5"))).toHaveLength(2);
    // Another PR's review cannot authorize this release.
    s.github.reviews.splice(0, 1, {
      repo: REPO,
      pullNumber: 6,
      login: "po",
      type: "User",
      state: "APPROVED",
      commitId: HEAD,
    });
    refused(await s.check(), "PO_APPROVAL_MISSING");
  });

  it("unions classic protection, ruleset and configured checks and uses the highest native count", async () => {
    const s = setup();
    s.github.protections.set(`${REPO}:main`, {
      enforce_admins: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 2 },
      required_status_checks: { contexts: ["classic"], checks: [{ context: "app-check" }] },
    });
    s.github.rules.set(`${REPO}:main`, [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ruleset" }] },
      },
    ]);
    refused(await s.check(), "NATIVE_APPROVAL_MISSING");
    refused(await s.check(), "REQUIRED_CHECK_MISSING");
    for (const context of ["classic", "app-check", "ruleset"])
      s.github.statuses.push({ repo: REPO, sha: HEAD, context, state: "success" });
    s.github.reviews.push({
      repo: REPO,
      pullNumber: 5,
      login: "reviewer",
      type: "User",
      state: "APPROVED",
      commitId: HEAD,
    });
    expect(await s.check()).toEqual({ allowed: true });
    s.github.rules.set(`${REPO}:main`, [
      { type: "pull_request", parameters: { required_approving_review_count: 3 } },
    ]);
    refused(await s.check(), "NATIVE_APPROVAL_MISSING");
  });

  it.each([
    ["/reviews", "REVIEWS_READ_UNAVAILABLE"],
    ["/rules/", "RULES_READ_UNAVAILABLE"],
    ["/protection", "PERMISSIONS_READ_UNAVAILABLE"],
    ["/check-runs", "CHECKS_READ_UNAVAILABLE"],
    ["/pulls/5", "PR_READ_UNAVAILABLE"],
    ["user", "PERMISSIONS_READ_UNAVAILABLE"],
  ])("refuses unreadable %s", async (path, reason) => {
    const s = setup();
    s.github.inject({ method: "GET", pathIncludes: path, effect: { type: "status", status: 403 } });
    refused(await s.check(), reason);
  });

  it("refuses ambiguous protection 404 even for admins, and accepts readable protection as a writer", async () => {
    const s = setup();
    s.github.protections.delete(`${REPO}:main`);
    refused(await s.check(), "PERMISSIONS_READ_UNAVAILABLE");
    s.github.repositoryPermissions.admin = false;
    refused(await s.check(), "PERMISSIONS_READ_UNAVAILABLE");
    s.github.protections.set(`${REPO}:main`, { enforce_admins: { enabled: true } });
    expect(await s.check()).toEqual({ allowed: true });
  });

  it("refuses no write permission, locked branches and unproven push restrictions even for admins", async () => {
    const s = setup();
    s.github.repositoryPermissions.push = false;
    refused(await s.check(), "MERGE_PERMISSION_DENIED");
    s.github.repositoryPermissions.push = true;
    s.github.protections.set(`${REPO}:main`, {
      enforce_admins: { enabled: true },
      lock_branch: { enabled: true },
    });
    refused(await s.check(), "MERGE_PERMISSION_DENIED");
    s.github.protections.set(`${REPO}:main`, {
      enforce_admins: { enabled: true },
      restrictions: { users: [], teams: [{ slug: "release" }], apps: [] },
    });
    refused(await s.check(), "MERGE_PERMISSION_DENIED");
    s.github.protections.set(`${REPO}:main`, {
      enforce_admins: { enabled: true },
      restrictions: { users: [{ login: "OMI-BOT" }], teams: [], apps: [] },
    });
    expect(await s.check()).toEqual({ allowed: true });
  });

  it("does not count the runtime's PO identity, a stale PO review, dismissal or requested changes", async () => {
    const s = setup();
    s.github.authenticatedLogin = "PO";
    refused(await s.check(), "PO_APPROVAL_MISSING");
    s.github.authenticatedLogin = "omi-bot";
    s.github.reviews.splice(0, 1, {
      repo: REPO,
      pullNumber: 5,
      login: "po",
      type: "User",
      state: "APPROVED",
      commitId: OLD,
    });
    refused(await s.check(), "PO_APPROVAL_STALE");
    s.github.reviews.push({
      repo: REPO,
      pullNumber: 5,
      login: "PO",
      type: "User",
      state: "DISMISSED",
      commitId: HEAD,
    });
    refused(await s.check(), "PO_APPROVAL_MISSING");
    s.github.reviews.push({
      repo: REPO,
      pullNumber: 5,
      login: "po",
      type: "User",
      state: "CHANGES_REQUESTED",
      commitId: HEAD,
    });
    refused(await s.check(), "NATIVE_CHANGES_REQUESTED");
  });

  it("refuses a push during gate reads", async () => {
    const s = setup();
    const reader = {
      ...s.reader,
      async checks(repository: string, sha: string) {
        const checks = await s.reader.checks(repository, sha);
        const pull = s.github.pulls[0];
        if (pull !== undefined) pull.headSha = OLD;
        return checks;
      },
    };
    refused(await checkReleaseMerge(reader, request), "HEAD_MOVED");
  });

  it("refuses invalid commands, malformed rules/protection and mismatched PR identity", async () => {
    const s = setup();
    refused(
      await checkReleaseMerge(s.reader, { ...request, approved: true }),
      "INVALID_RELEASE_REQUEST",
    );
    s.github.rules.set(`${REPO}:main`, [{ type: "pull_request", parameters: {} }]);
    refused(await s.check(), "RULES_READ_UNAVAILABLE");
    s.github.protections.set(`${REPO}:main`, {
      enforce_admins: { enabled: true },
      restrictions: {},
    });
    refused(await s.check(), "PERMISSIONS_READ_UNAVAILABLE");
    const pull = await s.reader.pull(REPO, 5);
    refused(
      await checkReleaseMerge(
        { ...s.reader, pull: () => Promise.resolve({ ...pull, number: 6 }) },
        request,
      ),
      "PR_IDENTITY_MISMATCH",
    );
  });
});
