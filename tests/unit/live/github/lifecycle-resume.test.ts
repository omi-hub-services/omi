import { describe, expect, it } from "vitest";
import { decideReleaseResume, decideTaskResume } from "../../../live/github/lifecycle-resume.ts";

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

describe("decideTaskResume", () => {
  it("runs normally without a mapping", () => {
    expect(decideTaskResume({ reviewedHeadSha: head })).toEqual({ action: "run" });
  });
  it("skips a PR merged on the reviewed head and present on develop", () => {
    expect(decideTaskResume({ reviewedHeadSha: head, pull: pull(), onDevelop: true })).toEqual({
      action: "skip",
      prNumber: 11,
      mergeCommitSha: merge,
    });
  });
  it("runs normally while the mapped PR is still open", () => {
    expect(
      decideTaskResume({
        reviewedHeadSha: head,
        pull: pull({ state: "open", merged: false, mergeCommitSha: null }),
      }),
    ).toEqual({ action: "run" });
  });
  it("refuses a PR closed without merge", () => {
    expect(() =>
      decideTaskResume({
        reviewedHeadSha: head,
        pull: pull({ merged: false, mergeCommitSha: null }),
      }),
    ).toThrow(/closed without merge/);
  });
  it("refuses a merged PR whose head differs from the review", () => {
    expect(() =>
      decideTaskResume({
        reviewedHeadSha: head,
        pull: pull({ headSha: "c".repeat(40) }),
        onDevelop: true,
      }),
    ).toThrow(/reviewed head/);
  });
  it("refuses a merged PR into another base", () => {
    expect(() =>
      decideTaskResume({ reviewedHeadSha: head, pull: pull({ baseRef: "main" }), onDevelop: true }),
    ).toThrow(/develop/);
  });
  it("refuses a merge commit that is not on develop", () => {
    expect(() =>
      decideTaskResume({ reviewedHeadSha: head, pull: pull(), onDevelop: false }),
    ).toThrow(/not on develop/);
  });
  it("refuses a merged PR without a merge commit", () => {
    expect(() =>
      decideTaskResume({
        reviewedHeadSha: head,
        pull: pull({ mergeCommitSha: null }),
        onDevelop: true,
      }),
    ).toThrow(/not on develop/);
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
