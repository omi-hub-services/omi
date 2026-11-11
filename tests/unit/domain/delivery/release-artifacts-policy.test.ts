import { describe, expect, it } from "vitest";
import {
  evaluateReleaseArtifacts,
  releaseNotes,
  releaseTasks,
} from "../../../../src/domain/delivery/release-policy.ts";
import type { ReleaseArtifactInputs } from "../../../../src/domain/delivery/release-policy.ts";

const SHA = "c".repeat(40);
const merged: ReleaseArtifactInputs = {
  headRef: "develop",
  baseRef: "main",
  state: "closed",
  merged: true,
  mergeCommitSha: SHA,
  onMain: true,
};

describe("evaluateReleaseArtifacts", () => {
  it("allows a merged develop to main PR whose merge commit is on main", () => {
    expect(evaluateReleaseArtifacts(merged)).toEqual({ allowed: true });
  });
  it("refuses an open PR and a PR closed without merging", () => {
    for (const input of [
      { ...merged, state: "open" as const, merged: false, mergeCommitSha: null },
      { ...merged, merged: false, mergeCommitSha: null },
    ]) {
      expect(evaluateReleaseArtifacts(input)).toMatchObject({
        allowed: false,
        reason: "RELEASE_PR_NOT_MERGED",
      });
    }
  });
  it("refuses a missing merge commit, one not on main and a wrong branch flow", () => {
    expect(evaluateReleaseArtifacts({ ...merged, mergeCommitSha: null })).toMatchObject({
      reason: "MERGE_COMMIT_MISSING",
    });
    expect(evaluateReleaseArtifacts({ ...merged, onMain: false })).toMatchObject({
      reason: "MERGE_COMMIT_NOT_ON_MAIN",
    });
    expect(evaluateReleaseArtifacts({ ...merged, headRef: "task/omi-1-x" })).toMatchObject({
      reason: "WRONG_RELEASE_BRANCH_FLOW",
    });
  });
});

describe("releaseNotes and the release window", () => {
  const pull = (number: number, mergedAt: string) => ({
    number,
    title: `Task\n${String(number)}`,
    body: `Issue: #${String(number + 10)}`,
    head: `task/omi-0${String(number)}-x`,
    mergedAt,
  });
  it("bounds tasks by the previous release and by this release's own merge time", () => {
    const tasks = releaseTasks(
      [
        pull(1, "2026-01-01T00:00:00Z"),
        pull(2, "2026-02-01T00:00:00Z"),
        pull(3, "2026-03-01T00:00:00Z"),
      ],
      "2026-01-15T00:00:00Z",
      "2026-02-01T00:00:00Z",
    );
    expect(tasks.map((t) => t.pullNumber)).toEqual([2]);
  });
  it("names the commit and keeps each task on one line", () => {
    const notes = releaseNotes(
      "v1",
      9,
      SHA,
      releaseTasks([pull(2, "2026-02-01T00:00:00Z")], undefined),
    );
    expect(notes).toContain(`Commit: ${SHA}`);
    expect(notes).toContain("- OMI-02 · Issue #12 · PR #2: Task 2");
  });
});
