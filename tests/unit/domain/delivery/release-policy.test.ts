import { describe, expect, it } from "vitest";
import {
  hasClosingReference,
  isReleaseBranchFlow,
  releaseIssueBody,
  releaseTasks,
} from "../../../../src/domain/delivery/release-policy.ts";

const pull = (number: number, mergedAt: string, head = `task/omi-00${String(number)}-x`) => ({
  number,
  title: `Task ${String(number)}`,
  body: `Issue: #${String(number + 10)}\n`,
  head,
  mergedAt,
});

describe("releaseTasks", () => {
  it("keeps only PRs merged after the last release, oldest first, with task and Issue refs", () => {
    const tasks = releaseTasks(
      [
        pull(3, "2026-02-03T00:00:00Z"),
        pull(1, "2026-01-01T00:00:00Z"),
        pull(2, "2026-02-01T00:00:00Z"),
      ],
      "2026-02-01T00:00:00Z",
    );
    expect(tasks).toEqual([
      { pullNumber: 3, title: "Task 3", taskKey: "OMI-003", issueNumber: 13 },
    ]);
  });
  it("recognises a task branch of another Plan Key prefix", () => {
    const [task] = releaseTasks(
      [pull(1, "2026-01-01T00:00:00Z", "task/bn-001-first-slice")],
      undefined,
    );
    expect(task?.taskKey).toBe("BN-001");
  });
  it("takes everything when there was no earlier release", () => {
    expect(
      releaseTasks(
        [pull(2, "2026-02-01T00:00:00Z"), pull(1, "2026-01-01T00:00:00Z")],
        undefined,
      ).map((t) => t.pullNumber),
    ).toEqual([1, 2]);
  });
  it("tolerates non-task branches", () => {
    const [task] = releaseTasks(
      [{ ...pull(1, "2026-01-01T00:00:00Z"), head: "hotfix/x", body: "" }],
      undefined,
    );
    expect(task).toMatchObject({ taskKey: undefined, issueNumber: undefined });
  });
});

describe("release text and branch flow", () => {
  it("flattens untrusted titles to one line", () => {
    const body = releaseIssueBody("r1", [
      { pullNumber: 1, title: "a\n## injected", taskKey: undefined, issueNumber: undefined },
    ]);
    expect(body).toContain("- PR #1: a ## injected");
    expect(body).not.toContain("\n## injected");
  });
  it("detects closing references", () => {
    expect(hasClosingReference("Closes #4")).toBe(true);
    expect(hasClosingReference("Release Issue: #4")).toBe(false);
  });
  it("accepts exactly develop to main", () => {
    expect(isReleaseBranchFlow("develop", "main")).toBe(true);
    expect(isReleaseBranchFlow("release/1", "main")).toBe(false);
    expect(isReleaseBranchFlow("develop", "develop")).toBe(false);
  });
});
