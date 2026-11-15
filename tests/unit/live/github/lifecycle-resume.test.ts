import { describe, expect, it } from "vitest";
import type { MergeEvidence } from "../../../../src/application/contracts/merge-delivery.ts";
import {
  decideReleaseResume,
  decideTaskResume,
  resolveReleaseIdentity,
} from "../../../live/github/lifecycle-resume.ts";

const head = "a".repeat(40);
const merge = "b".repeat(40);
const pull = (over: Record<string, unknown> = {}) => ({
  number: 11,
  state: "closed",
  merged: true,
  headSha: head,
  baseRef: "develop",
  mergeCommitSha: merge as string | null,
  ...over,
});
const issueBody = "## Acceptance criteria\n- [ ] first\n- [ ] second\n";
const evidence = (
  review: Partial<NonNullable<MergeEvidence["review"]>> = {},
  authors: Partial<MergeEvidence> = {},
): MergeEvidence => ({
  review: {
    reviewerRunId: "review-run",
    reviewerAgentId: "reviewer",
    headSha: head,
    baseSha: "d".repeat(40),
    verdict: "pass",
    body: "AC-1: met — done\nAC-2: met — done",
    ...review,
  },
  authorRunIds: ["author-run"],
  authorAgentIds: ["author"],
  unresolvedMandatoryFindings: 0,
  workflowGatesPassed: true,
  ...authors,
});
const merged = { evidence: evidence(), issueBody, pull: pull(), onDevelop: true };

describe("decideTaskResume", () => {
  it("runs normally without a mapping", () => {
    expect(decideTaskResume({ evidence: evidence() })).toEqual({ action: "run" });
  });
  it("skips a PR merged on the reviewed head, on develop, with an independent passing review", () => {
    expect(decideTaskResume(merged)).toEqual({
      action: "skip",
      prNumber: 11,
      mergeCommitSha: merge,
    });
  });
  it("runs normally while the mapped PR is still open", () => {
    expect(
      decideTaskResume({
        evidence: evidence(),
        pull: pull({ state: "open", merged: false, mergeCommitSha: null }),
      }),
    ).toEqual({ action: "run" });
  });
  it("refuses a PR closed without merge", () => {
    expect(() =>
      decideTaskResume({ ...merged, pull: pull({ merged: false, mergeCommitSha: null }) }),
    ).toThrow(/closed without merge/);
  });
  it("refuses a merged PR whose head differs from the review", () => {
    expect(() => decideTaskResume({ ...merged, pull: pull({ headSha: "c".repeat(40) }) })).toThrow(
      /reviewed head/,
    );
  });
  it("refuses a merged PR into another base", () => {
    expect(() => decideTaskResume({ ...merged, pull: pull({ baseRef: "main" }) })).toThrow(
      /develop/,
    );
  });
  it("refuses a merge commit that is not on develop", () => {
    expect(() => decideTaskResume({ ...merged, onDevelop: false })).toThrow(/not on develop/);
  });
  it("refuses a merged PR without a merge commit", () => {
    expect(() => decideTaskResume({ ...merged, pull: pull({ mergeCommitSha: null }) })).toThrow(
      /not on develop/,
    );
  });
  it("refuses a merged PR when there is no review", () => {
    expect(() =>
      decideTaskResume({ ...merged, evidence: { ...evidence(), review: undefined } }),
    ).toThrow(/independent review required/);
  });
  it("refuses a failed review", () => {
    expect(() => decideTaskResume({ ...merged, evidence: evidence({ verdict: "fail" }) })).toThrow(
      /REVIEW_NOT_PASSED/,
    );
  });
  it("refuses a reviewer who is also an author", () => {
    expect(() =>
      decideTaskResume({ ...merged, evidence: evidence({ reviewerAgentId: "author" }) }),
    ).toThrow(/REVIEW_NOT_INDEPENDENT/);
    expect(() =>
      decideTaskResume({ ...merged, evidence: evidence({ reviewerRunId: "author-run" }) }),
    ).toThrow(/REVIEW_NOT_INDEPENDENT/);
  });
  it("refuses blank reviewer identities", () => {
    expect(() =>
      decideTaskResume({ ...merged, evidence: evidence({ reviewerRunId: " " }) }),
    ).toThrow(/REVIEW_NOT_INDEPENDENT/);
  });
  it("refuses incomplete or unmet acceptance evidence", () => {
    expect(() =>
      decideTaskResume({ ...merged, evidence: evidence({ body: "AC-1: met — done" }) }),
    ).toThrow(/review not acceptable/);
    expect(() =>
      decideTaskResume({
        ...merged,
        evidence: evidence({ body: "AC-1: met — done\nAC-2: not met — missing" }),
      }),
    ).toThrow(/review not acceptable/);
  });
});

describe("decideReleaseResume", () => {
  const po = ["ttin-omihub"];
  const approved = { actor: "ttin-omihub", actorType: "User", state: "APPROVED", commitSha: head };
  const rel = (over: Record<string, unknown> = {}) => pull({ baseRef: "main", ...over });
  it("waits while the release PR is open", () => {
    expect(
      decideReleaseResume({
        pull: rel({ state: "open", merged: false, mergeCommitSha: null }),
        reviews: [],
        poActors: po,
      }),
    ).toEqual({ action: "wait" });
  });
  it("skips a release merged on the head the PO approved", () => {
    expect(
      decideReleaseResume({ pull: rel(), onMain: true, reviews: [approved], poActors: po }),
    ).toEqual({ action: "skip", mergeCommitSha: merge });
  });
  it("refuses a merged release without PO approval on that head", () => {
    expect(() =>
      decideReleaseResume({
        pull: rel(),
        onMain: true,
        reviews: [
          { ...approved, commitSha: "c".repeat(40) },
          { ...approved, actor: "other" },
        ],
        poActors: po,
      }),
    ).toThrow(/PO approval/);
  });
  it("refuses when the PO's latest review on the head is not an approval", () => {
    expect(() =>
      decideReleaseResume({
        pull: rel(),
        onMain: true,
        reviews: [approved, { ...approved, state: "CHANGES_REQUESTED" }],
        poActors: po,
      }),
    ).toThrow(/PO approval/);
  });
  it("refuses a release closed without merge", () => {
    expect(() =>
      decideReleaseResume({
        pull: rel({ merged: false, mergeCommitSha: null }),
        reviews: [approved],
        poActors: po,
      }),
    ).toThrow(/closed without merge/);
  });
  it("refuses a release merge commit not on main", () => {
    expect(() =>
      decideReleaseResume({ pull: rel(), onMain: false, reviews: [approved], poActors: po }),
    ).toThrow(/not on main/);
  });
});

describe("resolveReleaseIdentity", () => {
  const task = (n: number, mergedAt: string) => ({
    number: n,
    title: `t${String(n)}`,
    body: "",
    head: "task/x",
    mergedAt,
  });
  const releasePr = (n: number, release: string, mergedAt: string) => ({
    number: n,
    title: release,
    body: `Release Issue: #1\nRelease: ${release}\n`,
    head: "develop",
    mergedAt,
  });
  const fakes = (opts: {
    open?: boolean;
    develop?: ReturnType<typeof task>[];
    releases?: ReturnType<typeof releasePr>[];
  }) => {
    const releases = opts.releases ?? [];
    const last = releases
      .map((r) => r.mergedAt)
      .sort()
      .at(-1);
    return {
      pulls: {
        findOpenPull: () =>
          Promise.resolve(
            opts.open === true ? { number: 14, head: "develop", base: "main" } : undefined,
          ),
      },
      releases: {
        mergedDevelopPulls: () => Promise.resolve(opts.develop ?? []),
        lastReleaseMergedAt: () => Promise.resolve(last),
        mergedReleasePulls: () => Promise.resolve(releases),
      },
    } as unknown as Parameters<typeof resolveReleaseIdentity>[0];
  };
  const repo = "omi-hub-services/omi-sandbox";

  it("prepares as usual while the release PR is open", async () => {
    expect(await resolveReleaseIdentity(fakes({ open: true }), repo, "v1")).toEqual({
      kind: "prepare",
    });
  });
  it("prepares as usual when merged tasks still wait for a release", async () => {
    const deps = fakes({ develop: [task(11, "2026-11-13T10:00:00Z")] });
    expect(await resolveReleaseIdentity(deps, repo, "v1")).toEqual({ kind: "prepare" });
  });
  it("finds the merged release PR on a restart after the release merge", async () => {
    const deps = fakes({
      develop: [task(11, "2026-11-13T10:00:00Z")],
      releases: [
        releasePr(9, "v0", "2026-11-01T10:00:00Z"),
        releasePr(14, "v1", "2026-11-13T12:00:00Z"),
      ],
    });
    expect(await resolveReleaseIdentity(deps, repo, "v1")).toEqual({
      kind: "merged",
      prNumber: 14,
    });
  });
  it("refuses when no release PR names this release", async () => {
    const deps = fakes({ releases: [releasePr(9, "v0", "2026-11-01T10:00:00Z")] });
    await expect(resolveReleaseIdentity(deps, repo, "v1")).rejects.toThrow(/nothing to release/);
  });
});
