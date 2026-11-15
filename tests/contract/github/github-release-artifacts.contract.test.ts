import { describe, expect, it } from "vitest";
import { publishRelease } from "../../../src/application/use-cases/delivery/publish-release.ts";
import { createGithubMergeDelivery } from "../../../src/infrastructure/github/github-merge-delivery.ts";
import { createGithubReleaseReader } from "../../../src/infrastructure/github/github-release-reader.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { preparationHarness } from "../../unit/application/use-cases/delivery/prepare-pr-fakes.ts";
import { FakeGithub } from "./fake-github.ts";

const REPO = "acme/app";
const MERGE_SHA = "c".repeat(40);
const request = { repository: REPO, release: "v1.0.0", prNumber: 10 };

function setup(options: { merged: boolean } = { merged: true }) {
  const h = preparationHarness();
  const fake = new FakeGithub({ maxPageSize: 1 });
  const at = new Date(h.clock.ms).toISOString();
  const task = (number: number, issue: number, mergedAt: string) =>
    fake.pulls.push({
      repo: REPO,
      number,
      title: `Task ${String(number)}`,
      body: `Issue: #${String(issue)}`,
      createdAt: at,
      head: `task/omi-0${String(issue)}-x`,
      base: "develop",
      merged: true,
      mergedAt,
    });
  task(1, 31, "2026-10-01T00:00:00Z"); // shipped by the previous release
  task(2, 32, "2026-10-20T00:00:00Z");
  task(3, 33, "2026-10-25T00:00:00Z");
  task(6, 36, "2026-11-05T00:00:00Z"); // merged into develop after this release: next release
  const release = (number: number, mergedAt: string) =>
    fake.pulls.push({
      repo: REPO,
      number,
      title: `Release ${String(number)}`,
      body: "",
      createdAt: at,
      head: "develop",
      base: "main",
      merged: true,
      mergedAt,
      state: "closed",
      mergeCommitSha: MERGE_SHA,
    });
  release(4, "2026-10-10T00:00:00Z");
  if (options.merged) {
    release(10, "2026-11-01T00:00:00Z");
    fake.branches.set(`${REPO}:main`, MERGE_SHA);
    fake.commits.set(MERGE_SHA, { repo: REPO, parents: [] });
  } else {
    fake.pulls.push({
      repo: REPO,
      number: 10,
      title: "Release",
      body: "",
      createdAt: at,
      head: "develop",
      base: "main",
    });
    fake.branches.set(`${REPO}:main`, "b".repeat(40));
  }
  const client = createGithubRestClient({
    transport: fake,
    now: () => h.clock.ms,
    random: () => 0,
    sleep: () => Promise.resolve(),
    policy: { maxTries: 1 },
  });
  const deps = {
    ...h.deps,
    github: createGithubRemote(client),
    releases: createGithubReleaseReader(client),
    pulls: createGithubMergeDelivery(client),
  };
  return { ...h, deps, fake };
}

const writes = (fake: FakeGithub) => fake.requests.filter((r) => r.method !== "GET");

describe("release artifacts against fake GitHub", () => {
  it("creates no tag or release while the release PR is open", async () => {
    const h = setup({ merged: false });
    expect(await publishRelease(h.deps, request)).toEqual({
      status: "refused",
      reason: "RELEASE_PR_NOT_MERGED",
    });
    expect(writes(h.fake)).toEqual([]);
    expect(h.fake.tags.size).toBe(0);
    expect(h.fake.releases).toEqual([]);
  });

  it("refuses a release PR that was closed without merging", async () => {
    const h = setup({ merged: false });
    const open = h.fake.pulls.find((p) => p.number === 10);
    if (open !== undefined) open.state = "closed";
    expect(await publishRelease(h.deps, request)).toMatchObject({
      status: "refused",
      reason: "RELEASE_PR_NOT_MERGED",
    });
    expect(h.fake.releases).toEqual([]);
  });

  it("tags the exact merge commit and lists only this release's tasks in the notes", async () => {
    const h = setup();
    const result = await publishRelease(h.deps, request);
    expect(result).toMatchObject({ status: "published", tag: "v1.0.0", commitSha: MERGE_SHA });
    expect(h.fake.tags.get(`${REPO}:v1.0.0`)).toBe(MERGE_SHA);
    expect(h.fake.releases).toHaveLength(1);
    const notes = h.fake.releases[0]?.body ?? "";
    expect(notes).toContain(`Commit: ${MERGE_SHA}`);
    expect(notes).toContain("Release PR: #10");
    expect(notes).toContain("PR #2");
    expect(notes).toContain("PR #3");
    expect(notes).not.toContain("PR #1:");
    expect(notes).not.toContain("PR #6");
    expect(h.fake.releases[0]?.tag).toBe("v1.0.0");
  });

  it("is idempotent on repeat calls", async () => {
    const h = setup();
    await publishRelease(h.deps, request);
    await publishRelease(h.deps, request);
    expect(h.fake.tags.size).toBe(1);
    expect(h.fake.releases).toHaveLength(1);
    expect(writes(h.fake).filter((r) => r.method === "POST")).toHaveLength(2);
  });

  it("does not duplicate the tag or the release after a lost response", async () => {
    const h = setup();
    h.fake.inject({
      method: "POST",
      pathIncludes: "/git/refs",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    h.fake.inject({
      method: "POST",
      pathIncludes: "/releases",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    expect(await publishRelease(h.deps, request)).toMatchObject({ status: "pending" });
    h.clock.ms += 60 * 60_000;
    let last = await publishRelease(h.deps, request);
    for (let i = 0; i < 3 && last.status === "pending"; i += 1) {
      h.clock.ms += 60 * 60_000;
      last = await publishRelease(h.deps, request);
    }
    expect(last).toMatchObject({ status: "published", commitSha: MERGE_SHA });
    expect(h.fake.tags.size).toBe(1);
    expect(h.fake.releases).toHaveLength(1);
  });

  it("refuses a tag that already points at another commit and never moves it", async () => {
    const h = setup();
    h.fake.tags.set(`${REPO}:v1.0.0`, "d".repeat(40));
    await expect(publishRelease(h.deps, request)).rejects.toThrow("TAG_POINTS_ELSEWHERE");
    expect(h.fake.tags.get(`${REPO}:v1.0.0`)).toBe("d".repeat(40));
    expect(h.fake.releases).toEqual([]);
  });

  it("refuses to adopt a release for the tag that this operation did not write", async () => {
    const h = setup();
    h.fake.tags.set(`${REPO}:v1.0.0`, MERGE_SHA);
    h.fake.releases.push({ id: 5, repo: REPO, tag: "v1.0.0", name: "Hand made", body: "x" });
    await expect(publishRelease(h.deps, request)).rejects.toThrow("RELEASE_EXISTS_UNMARKED");
    expect(h.fake.releases).toHaveLength(1);
  });

  it("does not trust an incomplete merged-PR listing", async () => {
    const h = setup();
    h.fake.inject({
      method: "GET",
      pathIncludes: "/pulls?",
      effect: { type: "status", status: 503 },
    });
    await expect(publishRelease(h.deps, request)).rejects.toThrow("HTTP_503");
    expect(writes(h.fake)).toEqual([]);
  });
});
