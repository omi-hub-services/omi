import { describe, expect, it } from "vitest";
import { prepareRelease } from "../../../src/application/use-cases/delivery/prepare-release.ts";
import { createGithubPrDelivery } from "../../../src/infrastructure/github/github-pr-delivery.ts";
import { createGithubReleaseReader } from "../../../src/infrastructure/github/github-release-reader.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { preparationHarness } from "../../unit/application/use-cases/delivery/prepare-pr-fakes.ts";
import { FakeGithub } from "./fake-github.ts";

const REPO = "acme/app";
const request = { repository: REPO, release: "r1" };

function setup() {
  const h = preparationHarness();
  const fake = new FakeGithub({ maxPageSize: 1 });
  const at = new Date(h.clock.ms).toISOString();
  const task = (number: number, issue: number, mergedAt: string, base = "develop") =>
    fake.pulls.push({
      repo: REPO,
      number,
      title: `Task ${String(number)}`,
      body: `Issue: #${String(issue)}`,
      createdAt: at,
      head: `task/omi-0${String(issue)}-x`,
      base,
      merged: true,
      mergedAt,
    });
  task(1, 31, "2026-10-01T00:00:00Z");
  task(2, 32, "2026-10-20T00:00:00Z");
  task(3, 33, "2026-10-25T00:00:00Z");
  // An earlier release merged develop into main on Oct 10, and a task PR closed unmerged.
  fake.pulls.push({
    repo: REPO,
    number: 4,
    title: "Release 0",
    body: "",
    createdAt: at,
    head: "develop",
    base: "main",
    merged: true,
    mergedAt: "2026-10-10T00:00:00Z",
  });
  fake.pulls.push({
    repo: REPO,
    number: 5,
    title: "Abandoned",
    body: "",
    createdAt: at,
    head: "task/omi-099-x",
    base: "develop",
    state: "closed",
  });
  fake.branches.set(`${REPO}:main`, "b".repeat(40));
  const client = createGithubRestClient({
    transport: fake,
    now: () => h.clock.ms,
    random: () => 0,
    sleep: () => Promise.resolve(),
    policy: { maxTries: 1 },
  });
  const prs = createGithubPrDelivery(client);
  const deps = {
    ...h.deps,
    github: createGithubRemote(client),
    releases: createGithubReleaseReader(client),
    pulls: prs,
  };
  return { ...h, deps, fake };
}

describe("release preparation against fake GitHub", () => {
  it("lists tasks merged since the last release in a Release Issue and opens develop to main", async () => {
    const h = setup();
    const result = await prepareRelease(h.deps, request);
    expect(result).toMatchObject({ status: "verified" });
    expect(h.fake.issues).toHaveLength(1);
    const issueBody = h.fake.issues[0]?.body ?? "";
    expect(issueBody).toContain("PR #2");
    expect(issueBody).toContain("PR #3");
    expect(issueBody).not.toContain("PR #1:");
    expect(issueBody).not.toContain("PR #5");
    const release = h.fake.pulls.find(
      (p) => p.head === "develop" && p.state !== "closed" && p.merged !== true,
    );
    expect(release).toMatchObject({ head: "develop", base: "main" });
    expect(release?.body).toContain(`Release Issue: #${String(h.fake.issues[0]?.number)}`);
  });
  it("keeps the branch flow: no release branch, PR is exactly develop to main", async () => {
    const h = setup();
    await prepareRelease(h.deps, request);
    const created = h.fake.pulls.filter((p) => p.number > 1000);
    expect(created.map((p) => `${p.head}>${p.base}`)).toEqual(["develop>main"]);
    expect(
      h.fake.requests.some((r) => r.method === "POST" && /git\/refs|branches/.test(r.path)),
    ).toBe(false);
  });
  it("never merges into main and leaves the PR open", async () => {
    const h = setup();
    await prepareRelease(h.deps, request);
    await prepareRelease(h.deps, request);
    expect(h.fake.requests.filter((r) => r.method === "PUT" || /merge/.test(r.path))).toEqual([]);
    expect(h.fake.branches.get(`${REPO}:main`)).toBe("b".repeat(40));
    const release = h.fake.pulls.find((p) => p.number > 1000);
    expect(release?.merged ?? false).toBe(false);
    expect(release?.state ?? "open").toBe("open");
  });
  it("is idempotent across a lost response and a retry", async () => {
    const h = setup();
    h.fake.inject({
      method: "POST",
      pathIncludes: "/issues",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    expect(await prepareRelease(h.deps, request)).toMatchObject({ status: "pending" });
    expect(await prepareRelease(h.deps, request)).toMatchObject({ status: "verified" });
    expect(await prepareRelease(h.deps, request)).toMatchObject({ status: "verified" });
    expect(h.fake.issues).toHaveLength(1);
    expect(h.fake.pulls.filter((p) => p.number > 1000)).toHaveLength(1);
  });
  it("refuses an incomplete merged-PR listing instead of treating it as empty", async () => {
    const h = setup();
    h.fake.inject({
      method: "GET",
      pathIncludes: "/pulls?",
      effect: { type: "status", status: 503 },
    });
    await expect(prepareRelease(h.deps, request)).rejects.toThrow("HTTP_503");
    expect(h.fake.requests.every((r) => r.method === "GET")).toBe(true);
  });
});
