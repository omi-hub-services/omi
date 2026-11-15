import { describe, expect, it } from "vitest";
import { preparePr } from "../../../src/application/use-cases/delivery/prepare-pr.ts";
import { createGithubPrDelivery } from "../../../src/infrastructure/github/github-pr-delivery.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import {
  preparationHarness,
  request,
} from "../../unit/application/use-cases/delivery/prepare-pr-fakes.ts";
import { FakeGithub } from "./fake-github.ts";

function setup(maxPageSize = 100) {
  const h = preparationHarness();
  const fake = new FakeGithub({ maxPageSize });
  fake.issues.push({
    repo: request.repository,
    number: 26,
    title: "Task",
    body: h.state.issueBody,
    createdAt: new Date(h.clock.ms).toISOString(),
  });
  const client = createGithubRestClient({
    transport: fake,
    now: () => h.clock.ms,
    random: () => 0,
    sleep: () => Promise.resolve(),
    policy: { maxTries: 1 },
  });
  const deps = {
    ...h.deps,
    reader: createGithubPrDelivery(client),
    github: createGithubRemote(client),
  };
  return { ...h, deps, fake };
}

describe("PR delivery against fake GitHub", () => {
  it("creates one develop PR with canonical reference, ordered evidence and verified backlink on retry", async () => {
    const h = setup();
    expect(await preparePr(h.deps, request)).toMatchObject({ status: "verified" });
    expect(await preparePr(h.deps, request)).toMatchObject({ status: "verified" });
    expect(h.fake.pulls).toHaveLength(1);
    expect(h.fake.comments).toHaveLength(1);
    expect(h.fake.pulls[0]).toMatchObject({ base: "develop", head: request.head });
    expect(h.fake.pulls[0]?.body).toMatch(
      /Issue: #26[\s\S]*AC-1: First criterion[\s\S]*unit suite[\s\S]*AC-2: Second criterion[\s\S]*contract suite/,
    );
    expect(h.fake.pulls[0]?.body).not.toMatch(/\bcloses\b/i);
    expect(h.state.mapping?.prNumber).toBe(h.fake.pulls[0]?.number);
  });
  it.each(["/pulls", "/comments"])(
    "recovers a timeout after success at %s without duplicates",
    async (path) => {
      const h = setup();
      h.fake.inject({
        method: "POST",
        pathIncludes: path,
        effect: { type: "apply_then_fail", failure: "timeout" },
      });
      expect(await preparePr(h.deps, request)).toMatchObject({
        status: "pending",
        state: "outcome_unknown",
      });
      expect(await preparePr(h.deps, request)).toMatchObject({ status: "verified" });
      expect(h.fake.pulls).toHaveLength(1);
      expect(h.fake.comments).toHaveLength(1);
      expect(h.fake.requests.filter((r) => r.method === "POST")).toHaveLength(2);
    },
  );
  it("refuses a missing AC section with no remote write", async () => {
    const h = setup();
    h.fake.issues.splice(0, 1, {
      ...h.fake.issues[0],
      repo: "acme/app",
      number: 26,
      title: "Task",
      body: "No section",
      createdAt: new Date().toISOString(),
    });
    await expect(preparePr(h.deps, request)).rejects.toThrow("AC_SECTION_EMPTY_OR_MISSING");
    expect(h.fake.requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("refuses an incomplete PR listing instead of treating it as absent", async () => {
    const h = setup();
    h.fake.inject({
      method: "GET",
      pathIncludes: "/pulls?",
      effect: { type: "status", status: 503 },
    });
    await expect(preparePr(h.deps, request)).rejects.toThrow("HTTP_503");
    expect(h.fake.pulls).toHaveLength(0);
  });
  it("verifies the written PR body rather than trusting a successful create response", async () => {
    const h = setup();
    h.fake.inject({
      method: "GET",
      pathIncludes: "/pulls/1001",
      effect: {
        type: "status",
        status: 200,
        body: JSON.stringify({
          number: 1001,
          body: "tampered",
          state: "open",
          html_url: "https://github.com/acme/app/pull/1001",
          head: { ref: request.head, repo: { full_name: "acme/app" } },
          base: { ref: "develop", repo: { full_name: "acme/app" } },
        }),
      },
    });
    await expect(preparePr(h.deps, request)).rejects.toThrow("PR_VERIFICATION_FAILED");
    expect(h.fake.comments).toHaveLength(0);
    expect(h.state.mapping).toBeUndefined();
  });
  it("reads all backlink pages and requires exact body plus operation marker", async () => {
    const h = setup(1);
    h.fake.addComment("acme/app", 26, "unrelated");
    h.fake.addComment("acme/app", 26, "forged reference");
    expect(await preparePr(h.deps, request)).toMatchObject({ status: "verified" });
    expect(await preparePr(h.deps, request)).toMatchObject({ status: "verified" });
    expect(h.fake.comments).toHaveLength(3);
    expect(h.fake.requests.some((r) => r.path.includes("page=3"))).toBe(true);
  });
  it("rejects malformed and wrong-repository PR read-back", async () => {
    const h = setup();
    h.fake.inject({
      method: "GET",
      pathIncludes: "/pulls?",
      effect: { type: "status", status: 200, body: '[{"number":1}]' },
    });
    await expect(preparePr(h.deps, request)).rejects.toThrow("INVALID_PR_RESPONSE");
    expect(h.fake.pulls).toHaveLength(0);
  });
});
