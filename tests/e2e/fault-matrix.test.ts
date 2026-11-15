/**
 * Architecture §16 fault matrix (paths relative to tests/).
 * Existing coverage is referenced, not re-executed by placeholder tests.
 *
 * Group   | Scenario                         | Authoritative test
 * crash   | Process dies mid file write      | integration/artifacts/local-artifact-store.test.ts
 *         |                                  | "a killed writer before linking publishes no partial artifact or DB row"
 * timeout | Remote PR created, response lost | integration/github/prepare-pr-flow.test.ts
 *         |                                  | "persists intents, recovers /pulls timeout after restart and preserves mapping conflicts atomically"
 * crash   | Restart after successful merge   | e2e/merge-task-pr.test.ts: "never merges or closes twice when responses are lost and the runtime restarts"
 * stale   | Two workers compete for worktree | integration/git/cli-git-workspace.test.ts
 *         |                                  | "admits exactly one writer when separate processes race"
 * stale   | Base branch changes after review | This file: "stale: base branch changes after review without any remote write" (added)
 * limits  | Profile hits its limit           | e2e/failover-from-checkpoint.test.ts
 *         |                                  | "stops the writer, reconciles, picks another profile and starts a new attempt"
 * stale   | Approval becomes stale           | integration/approvals/approval-lifecycle.test.ts
 *         |                                  | "makes a approved decision stale when its subject changes"
 * timeout | GitHub offline                   | integration/github/outbox-github-flow.test.ts
 *         |                                  | "keeps local state while offline and, once online, a later sync creates each effect without a duplicate"
 * cancel  | Coordinator closes during work   | integration/processes/owned-worker-run.test.ts
 *         |                                  | "stops the worker group when the owner's pipe closes, and keeps the worker's files"
 * stale   | Runtime restarts with old lease  | integration/processes/session-runtime.test.ts
 *         |                                  | "takes an expired unreleased lease with a higher generation and rejects all old-generation writes"
 *
 * No lost approval: integration/approvals/approval-lifecycle.test.ts:
 * "pins and approves a %s request with actor/source/hash" reopens SQLite for all four kinds;
 * "rolls back the request or decision when audit insertion fails" proves atomicity.
 *
 * The added flow assertion reuses the existing merge-task-pr sandbox.
 * Faults use FakeGithub and a fixed clock; no network, live CLI or real quota.
 */
import { describe, expect, it } from "vitest";
import { mergeTaskPr } from "../../src/application/use-cases/delivery/merge-task-pr.ts";
import { BASE, HEAD, ISSUE_BODY, PUSHED, REPO, request, sandbox } from "./merge-task-pr-sandbox.ts";

describe("architecture §16 fault matrix", () => {
  it("stale: base branch changes after review without any remote write", async () => {
    const s = sandbox();
    s.github.commits.set(PUSHED, { repo: REPO, parents: [BASE] });
    s.github.branches.set(`${REPO}:develop`, PUSHED);

    const result = await mergeTaskPr(s.deps, request);
    expect(result).toMatchObject({
      status: "refused",
      step: "merge",
    });
    expect(result.status === "refused" ? result.reasons : []).toContain("STALE_REVISION");
    expect(s.github.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(s.pull()?.merged ?? false).toBe(false);
    expect(s.issue()?.body).toBe(ISSUE_BODY);
    expect(s.task.status).toBe("in_progress");
    expect(s.task.completions).toEqual([]);
    expect(s.reviews.get(HEAD)?.baseSha).toBe(BASE);
  });
});
