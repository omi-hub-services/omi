// Read-only opt-in probe. The Coordinator/PO prepares and approves the sandbox PR separately.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { releaseMergeRequestSchema } from "../../../src/application/contracts/release-merge.ts";
import type { ReleaseMergeRequest } from "../../../src/application/contracts/release-merge.ts";
import { checkReleaseMerge } from "../../../src/application/use-cases/delivery/check-release-merge.ts";
import { createGhApiTransport } from "../../../src/infrastructure/github/gh-api-transport.ts";
import { createGithubReleaseMergeReader } from "../../../src/infrastructure/github/github-release-merge.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import type { ReleaseMergeReader } from "../../../src/application/ports/release-merge.ts";
import { assertSandboxTarget } from "./probe-model.ts";

const config = process.env["OMI_LIVE_RELEASE_CONFIG"];
// Unset skips; explicitly empty/invalid config fails. Never included in npm run check.
describe.skipIf(config === undefined)("OMI-038 sandbox native release restrictions (live)", () => {
  let request: ReleaseMergeRequest;
  let reader: ReleaseMergeReader;
  let scenario: "approved" | "missing-po" | "stale-po";
  const evidence: Record<string, unknown> = { task: "OMI-038" };
  beforeAll(() => {
    if (!config?.trim())
      throw new Error("OMI_LIVE_RELEASE_CONFIG must name a sandbox request JSON file");
    const raw: unknown = JSON.parse(readFileSync(resolve(config), "utf8"));
    const configured = z
      .strictObject({
        request: releaseMergeRequestSchema,
        scenario: z.enum(["approved", "missing-po", "stale-po"]),
      })
      .parse(raw);
    request = configured.request;
    scenario = configured.scenario;
    evidence["scenario"] = scenario;
    const owner = request.repository.split("/")[0];
    if (owner === undefined || !/sandbox/i.test(request.repository))
      throw new Error("sandbox repository required");
    assertSandboxTarget({ repo: request.repository, projectOwner: owner, projectNumber: 2 });
    const transport = createGhApiTransport();
    reader = createGithubReleaseMergeReader(
      createGithubRestClient({
        transport: {
          send(call) {
            if (
              call.method !== "GET" ||
              !(
                call.path === "user" ||
                call.path === `repos/${request.repository}` ||
                call.path.startsWith(`repos/${request.repository}/`)
              )
            )
              throw new Error("read-only sandbox guard refused call");
            return transport.send(call);
          },
        },
        now: () => Date.now(),
        random: () => Math.random(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    );
    evidence["repository"] = request.repository;
    evidence["prNumber"] = request.prNumber;
    evidence["headSha"] = request.expectedHeadSha;
  });
  afterAll(() => {
    const dir = resolve(import.meta.dirname, "../../../.tmp/live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "omi-038-release-approval-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
  });
  it("reads native restrictions and permits only the approved, green, exact sandbox head", async () => {
    const rules = await reader.branchRules(request.repository, "main");
    const actor = await reader.authenticatedActor();
    const protection = await reader.releaseRestrictions(request.repository, "main", actor);
    expect(
      Math.max(rules.requiredApprovingReviewCount, protection.requiredApprovingReviewCount),
    ).toBeGreaterThan(0);
    expect([...rules.requiredChecks, ...protection.requiredChecks].length).toBeGreaterThan(0);
    const result = await checkReleaseMerge(reader, request);
    evidence["gate"] = result;
    if (scenario === "approved") {
      expect(result).toEqual({ allowed: true });
    } else {
      const reason = scenario === "missing-po" ? "PO_APPROVAL_MISSING" : "PO_APPROVAL_STALE";
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reasons).toContain(reason);
      if (scenario === "missing-po") {
        // Prepare this phase with NO approving reviews, all checks green. GitHub itself must
        // expose the native review restriction as blocked, without attempting a real merge.
        const reviews = await reader.nativeReviews(request.repository, request.prNumber);
        expect(reviews.some((review) => review.state === "APPROVED")).toBe(false);
        const pull = await reader.pull(request.repository, request.prNumber);
        expect(pull.mergeableState).toBe("blocked");
        evidence["nativeMergeableState"] = pull.mergeableState;
      }
    }
    const stale = await checkReleaseMerge(reader, {
      ...request,
      expectedHeadSha: request.expectedHeadSha === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40),
    });
    evidence["staleHead"] = stale;
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) expect(stale.reasons).toContain("HEAD_MOVED");
  }, 120_000);
});
