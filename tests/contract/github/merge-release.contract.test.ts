import { describe, expect, it } from "vitest";
import { mergeRelease } from "../../../src/application/use-cases/delivery/merge-release.ts";
import type { MergeReleaseDeps } from "../../../src/application/use-cases/delivery/merge-release.ts";
import { createReleaseMergeUseCase } from "../../../src/bootstrap/container.ts";
import { operationMarker } from "../../../src/domain/delivery/operation-marker.ts";
import { releasePullKey } from "../../../src/domain/delivery/release-policy.ts";
import { createGithubReleaseMergeReader } from "../../../src/infrastructure/github/github-release-merge.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import {
  FakeArtifacts,
  InMemoryOutbox,
  START,
} from "../../unit/application/use-cases/sync/outbox-fakes.ts";
import type { HttpRequest } from "../../../src/infrastructure/github/github-transport.ts";
import { FakeGithub } from "./fake-github.ts";

const REPO = "acme/sandbox";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const request = {
  repository: REPO,
  release: "r1",
  prNumber: 5,
  expectedHeadSha: HEAD,
  poActors: ["po"],
  requiredChecks: ["ci"],
};

function setup() {
  const github = new FakeGithub();
  github.pulls.push({
    number: 5,
    repo: REPO,
    title: "Release r1",
    body: `Release Issue: #4\n\n${operationMarker(releasePullKey(REPO, "r1"))}`,
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
  const sent: HttpRequest[] = [];
  const client = createGithubRestClient({
    transport: {
      send: (req) => {
        sent.push(req);
        return github.send(req);
      },
    },
    now: () => START,
    random: () => 0,
    sleep: () => Promise.resolve(),
    policy: { maxTries: 1 },
  });
  const outbox = new InMemoryOutbox();
  const artifacts = new FakeArtifacts();
  let ids = 0;
  const deps: MergeReleaseDeps = {
    outbox,
    artifacts: {
      write: (input) => artifacts.put(input.path, input.bytes),
      read: artifacts.read.bind(artifacts),
      manifest: () => ({ schemaVersion: 1, artifacts: [] }),
    },
    unitOfWork: {
      commit: (change) => {
        if (change.outbox === undefined) throw new Error("INTENT_REQUIRED");
        outbox.seed({ ...change.outbox, createdAt: change.at, updatedAt: change.at });
        return { ok: true, newVersion: 0, eventSequence: 1 };
      },
    },
    github: createGithubRemote(client),
    reader: createGithubReleaseMergeReader(client),
    now: () => START,
    newId: () => `id-${String((ids += 1))}`,
    newEventId: () => `event-${String((ids += 1))}`,
    reconcileGraceMs: 60_000,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
    jitter: () => 0,
    batchSize: 10,
  };
  const puts = () => sent.filter((r) => r.method === "PUT");
  return { github, deps, puts, run: (input: unknown = request) => mergeRelease(deps, input) };
}

describe("mergeRelease over FakeGithub", () => {
  it("merges the PO-approved head with a pinned sha and confirms the commit on main", async () => {
    const s = setup();
    const result = await s.run();
    expect(result.status).toBe("done");
    expect(s.puts()).toHaveLength(1);
    expect(s.puts()[0]?.path).toContain("pulls/5/merge");
    expect(s.puts()[0]?.body).toMatchObject({ sha: HEAD, merge_method: "merge" });
    const pull = s.github.pulls[0];
    expect(pull?.merged).toBe(true);
    if (result.status === "done") expect(result.mergeCommitSha).toBe(pull?.mergeCommitSha);
    expect(s.github.branches.get(`${REPO}:main`)).toBe(pull?.mergeCommitSha);
  });

  it("is idempotent: running again sends no second merge and returns the same commit", async () => {
    const s = setup();
    const first = await s.run();
    const second = await s.run();
    expect(second).toEqual(first);
    expect(s.puts()).toHaveLength(1);
  });

  it("keeps the gate's reasons and writes nothing when PO approval is missing", async () => {
    const s = setup();
    s.github.reviews.splice(0, 1);
    const result = await s.run();
    expect(result).toMatchObject({ status: "refused", step: "gate" });
    if (result.status === "refused") expect(result.reasons).toContain("PO_APPROVAL_MISSING");
    expect(s.puts()).toHaveLength(0);
    expect(s.github.pulls[0]?.merged).toBeFalsy();
  });

  it("refuses with HEAD_MOVED when the PR head differs from the approved head", async () => {
    const s = setup();
    const result = await s.run({ ...request, expectedHeadSha: OTHER });
    expect(result).toMatchObject({ status: "refused", step: "gate" });
    if (result.status === "refused") expect(result.reasons).toContain("HEAD_MOVED");
    expect(s.puts()).toHaveLength(0);
  });

  it("refuses an invalid request without any GitHub call", async () => {
    const s = setup();
    const result = await s.run({ ...request, poActors: [] });
    expect(result).toMatchObject({
      status: "refused",
      step: "gate",
      reasons: ["INVALID_RELEASE_REQUEST"],
    });
    expect(s.github.requests).toHaveLength(0);
  });

  it("keeps GitHub's refusal when the pinned merge is rejected", async () => {
    const s = setup();
    s.github.inject({
      method: "PUT",
      pathIncludes: "/merge",
      effect: { type: "status", status: 409 },
    });
    const result = await s.run();
    expect(result).toMatchObject({ status: "refused", step: "merge" });
    if (result.status === "refused") expect(result.reasons[0]).toBe("MERGE_REJECTED");
    expect(s.github.pulls[0]?.merged).toBeFalsy();
  });

  it("never reports an earlier merge of another head as done", async () => {
    const s = setup();
    const pull = s.github.pulls[0];
    if (pull === undefined) throw new Error("PR missing");
    pull.merged = true;
    pull.state = "closed";
    pull.mergeCommitSha = "c".repeat(40);
    s.github.commits.set("c".repeat(40), { repo: REPO, parents: [HEAD] });
    s.github.branches.set(`${REPO}:main`, "c".repeat(40));
    const result = await s.run({ ...request, expectedHeadSha: OTHER });
    expect(result).toMatchObject({ status: "refused", step: "confirm" });
    expect(s.puts()).toHaveLength(0);
  });

  it.each([
    ["unavailable PR data", { type: "status" as const, status: 503 }],
    ["malformed PR data", { type: "status" as const, status: 200, body: "{}" }],
  ])("refuses with PR_READ_UNAVAILABLE and no PUT on %s", async (_name, effect) => {
    const s = setup();
    s.github.inject({ method: "GET", pathIncludes: "/pulls/5", times: 10, effect });
    expect(await s.run()).toEqual({
      status: "refused",
      step: "gate",
      reasons: ["PR_READ_UNAVAILABLE"],
    });
    expect(s.puts()).toHaveLength(0);
  });

  it("refuses with PR_IDENTITY_MISMATCH and no PUT when GitHub answers for another PR", async () => {
    const s = setup();
    const body = JSON.stringify({
      number: 6,
      title: "x",
      body: "",
      state: "open",
      draft: false,
      merged: false,
      merge_commit_sha: null,
      mergeable_state: "clean",
      user: { login: "agent" },
      html_url: `https://github.com/${REPO}/pull/6`,
      head: { ref: "develop", sha: HEAD, repo: { full_name: REPO } },
      base: { ref: "main", repo: { full_name: REPO } },
    });
    s.github.inject({
      method: "GET",
      pathIncludes: "/pulls/5",
      times: 10,
      effect: { type: "status", status: 200, body },
    });
    expect(await s.run()).toEqual({
      status: "refused",
      step: "gate",
      reasons: ["PR_IDENTITY_MISMATCH"],
    });
    expect(s.puts()).toHaveLength(0);
  });
});

describe("runtime composition of release merge", () => {
  // Only an ordinary reviewer approved: the caller names them as PO, configuration does not.
  function reviewerOnly() {
    const s = setup();
    s.github.reviews.splice(0, 1, {
      repo: REPO,
      pullNumber: 5,
      login: "reviewer",
      type: "User",
      state: "APPROVED",
      commitId: HEAD,
    });
    return s;
  }
  const command = {
    release: request.release,
    prNumber: request.prNumber,
    expectedHeadSha: request.expectedHeadSha,
    requiredChecks: request.requiredChecks,
  };

  it("ignores caller-named PO actors and keeps the configured allowlist", async () => {
    const s = reviewerOnly();
    const run = createReleaseMergeUseCase(s.deps, REPO, ["po"]);
    const outcome = await run({ ...command, poActors: ["reviewer"] });
    expect(outcome).toMatchObject({ ok: false, reason: "RELEASE_MERGE_REFUSED" });
    expect(JSON.stringify(outcome)).toContain("PO_APPROVAL_MISSING");
    expect(s.puts()).toHaveLength(0);
  });

  it("fails closed without a configured PO, before any GitHub read", async () => {
    const s = reviewerOnly();
    const run = createReleaseMergeUseCase(s.deps, REPO, []);
    expect(await run({ ...command, poActors: ["reviewer"] })).toEqual({
      ok: false,
      reason: "PO_ACTORS_NOT_CONFIGURED",
    });
    expect(s.github.requests).toHaveLength(0);
  });
});
