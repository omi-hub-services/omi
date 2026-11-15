import { describe, expect, it } from "vitest";
import { mergeTaskPr } from "../../src/application/use-cases/delivery/merge-task-pr.ts";
import { operationMarker } from "../../src/domain/delivery/operation-marker.ts";
import { BASE, HEAD, ISSUE_BODY, PUSHED, REPO, request, sandbox } from "./merge-task-pr-sandbox.ts";

const ISSUE = 27;
const PR = 128;
const NOW = Date.parse("2026-11-11T08:00:00.000Z");
const PR_CREATION_KEY = `create-pr:${REPO}:task-27:task/omi-023-merge-gates:develop`;

describe("merge a task PR, then tick, close and record Done", () => {
  it("merges the reviewed head, confirms it on develop, ticks only the AC section and closes", async () => {
    const s = sandbox();
    const result = await mergeTaskPr(s.deps, request);

    const mergeSha = s.pull()?.mergeCommitSha;
    expect(result).toEqual({ status: "done", mergeCommitSha: mergeSha, ticked: 2 });
    expect(s.github.branches.get(`${REPO}:develop`)).toBe(mergeSha);
    expect(s.github.commits.get(mergeSha ?? "")?.parents).toEqual([BASE, HEAD]);
    // Only the two criteria changed; the nested note and checkboxes in other sections did not.
    expect(s.issue()?.body).toBe(
      ISSUE_BODY.replace("- [ ] Independent", "- [x] Independent").replace(
        "- [ ] Head/base",
        "- [x] Head/base",
      ),
    );
    expect(s.issue()?.state).toBe("closed");
    expect(s.task.status).toBe("done");
    expect(s.task.completions).toMatchObject([{ mergeCommitSha: mergeSha, toStatus: "done" }]);
    // No review or approval was ever written to GitHub.
    expect(s.github.requests.some((r) => r.path.includes("/reviews") && r.method !== "GET")).toBe(
      false,
    );

    // Calling again changes nothing on GitHub.
    const before = s.github.requests.filter((r) => r.method !== "GET").length;
    expect(await mergeTaskPr(s.deps, request)).toMatchObject({ status: "done", ticked: 0 });
    expect(s.github.requests.filter((r) => r.method !== "GET").length).toBe(before);
    expect(s.writes("PUT", "/merge")).toBe(1);
  });

  it("refuses a PR whose head is not the reviewed SHA, and merges nothing", async () => {
    const s = sandbox();
    const pull = s.pull();
    if (pull !== undefined) pull.headSha = PUSHED;
    const result = await mergeTaskPr(s.deps, request);
    expect(result).toMatchObject({ status: "refused", step: "merge" });
    expect(result.status === "refused" ? result.reasons : []).toEqual(
      expect.arrayContaining(["HEAD_MOVED", "STALE_REVISION", "REQUIRED_CHECK_MISSING"]),
    );
    expect(s.writes("PUT", "/merge")).toBe(0);
    expect(s.issue()?.state ?? "open").toBe("open");
    expect(s.task.status).toBe("in_progress");
  });

  it("refuses a PR that does not carry the task's PR creation marker, and merges nothing", async () => {
    const s = sandbox();
    const pull = s.pull();
    if (pull !== undefined) pull.body = pull.body.replace(operationMarker(PR_CREATION_KEY), "");
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["PR_NOT_CORRELATED"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
  });

  it("refuses a failing required check on the exact head", async () => {
    const s = sandbox();
    s.github.checkRuns.push({
      repo: REPO,
      id: 2,
      name: "ci",
      headSha: HEAD,
      status: "completed",
      conclusion: "failure",
    });
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["CHECKS_FAILED"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
  });

  it("refuses a review without a line for every criterion", async () => {
    const s = sandbox();
    const review = s.reviews.get(HEAD);
    if (review !== undefined) {
      s.reviews.set(HEAD, { ...review, body: "**VERDICT:** PASS\nAC-1: met — reviewer differs" });
    }
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["AC_LINE_MISSING"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
    expect(s.issue()?.body).toBe(ISSUE_BODY);
  });

  it("refuses a review with a `not met` line", async () => {
    const s = sandbox();
    const review = s.reviews.get(HEAD);
    if (review !== undefined) {
      s.reviews.set(HEAD, {
        ...review,
        body: "AC-1: met — reviewer differs\nAC-2: not met — no failing-check test",
      });
    }
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["AC_NOT_MET"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
  });

  it("never merges or closes twice when responses are lost and the runtime restarts", async () => {
    const s = sandbox();
    // GitHub merges, then the response is lost.
    s.github.inject({
      method: "PUT",
      pathIncludes: "/merge",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    expect(await mergeTaskPr(s.deps, request)).toMatchObject({
      status: "pending",
      step: "merge",
      state: "outcome_unknown",
    });
    expect(s.pull()?.merged).toBe(true);
    expect(s.task.status).toBe("in_progress");

    // After a restart the merge is found by read-back; then the close response is lost too.
    s.github.inject({
      method: "PATCH",
      pathIncludes: `/issues/${String(ISSUE)}`,
      times: 2,
      effect: { type: "apply_then_fail", failure: "connection" },
    });
    let deps = s.restart();
    const second = await mergeTaskPr(deps, request);
    expect(second).toMatchObject({ status: "pending", step: "tick", state: "outcome_unknown" });

    deps = s.restart();
    expect(await mergeTaskPr(deps, request)).toMatchObject({
      status: "pending",
      step: "close",
      state: "outcome_unknown",
    });

    deps = s.restart();
    expect(await mergeTaskPr(deps, request)).toMatchObject({ status: "done" });
    expect(s.writes("PUT", "/merge")).toBe(1);
    expect(s.writes("PATCH", `/issues/${String(ISSUE)}`)).toBe(2);
    expect(s.issue()?.state).toBe("closed");
    expect(s.task.status).toBe("done");
    expect(deps.outbox.listUnresolved()).toHaveLength(0);
  });

  it("refuses to tick or close from a merged-head review that marks a criterion not met", async () => {
    const s = sandbox();
    // Someone merged the reviewed head outside the runtime; the review on it is not a full PASS.
    const pull = s.pull();
    const mergeSha = "e".repeat(40);
    if (pull !== undefined) {
      Object.assign(pull, { merged: true, mergeCommitSha: mergeSha, state: "closed" });
    }
    s.github.commits.set(mergeSha, { repo: REPO, parents: [BASE, HEAD] });
    s.github.branches.set(`${REPO}:develop`, mergeSha);
    const review = s.reviews.get(HEAD);
    if (review !== undefined) {
      s.reviews.set(HEAD, { ...review, body: "AC-1: met — a\nAC-2: not met — b" });
    }
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "tick",
      reasons: ["AC_NOT_MET"],
    });
    expect(s.issue()?.body).toBe(ISSUE_BODY);
    expect(s.issue()?.state ?? "open").toBe("open");
    expect(s.task.status).toBe("in_progress");
    expect(s.writes("PATCH", "/issues")).toBe(0);
  });

  it("does not tick or close the Issue for a task the task machine cannot move to Done", async () => {
    const s = sandbox();
    s.task.status = "ready";
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "done",
      reasons: ["TRANSITION_NOT_ALLOWED"],
    });
    expect(s.pull()?.merged).toBe(true);
    expect(s.issue()?.body).toBe(ISSUE_BODY);
    expect(s.issue()?.state ?? "open").toBe("open");
  });

  it("counts only a real native approval on the head when the ruleset requires one", async () => {
    const s = sandbox();
    s.github.rules.get(`${REPO}:develop`)?.push({
      type: "pull_request",
      parameters: { required_approving_review_count: 1 },
    });
    // The runtime's own account and an approval of an older head do not count.
    s.github.reviews.push(
      {
        repo: REPO,
        pullNumber: PR,
        login: "omi-bot",
        type: "User",
        state: "APPROVED",
        commitId: HEAD,
      },
      { repo: REPO, pullNumber: PR, login: "po", type: "User", state: "APPROVED", commitId: BASE },
    );
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["NATIVE_APPROVAL_MISSING"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);

    s.github.reviews.push({
      repo: REPO,
      pullNumber: PR,
      login: "po",
      type: "User",
      state: "APPROVED",
      commitId: HEAD,
    });
    expect(await mergeTaskPr(s.deps, request)).toMatchObject({ status: "done" });
  });

  describe("a PASS carried over a clean sync with develop", () => {
    const SYNCED = "d".repeat(40);
    const TREE = "e".repeat(40);
    const facts = (over: { headTree?: string; mergeTree?: string | null } = {}) => ({
      head: SYNCED,
      parents: [HEAD, BASE],
      secondParentOnBase: true,
      headTree: TREE,
      mergeTree: TREE,
      ...over,
    });
    /** The PR head moved to the sync commit and CI is green on it; only HEAD was reviewed. */
    function behindPr(carried: ReturnType<typeof facts>) {
      const s = sandbox();
      const pull = s.pull();
      if (pull !== undefined) pull.headSha = SYNCED;
      s.github.commits.set(SYNCED, { repo: REPO, parents: [HEAD, BASE] });
      s.github.checkRuns.push({
        repo: REPO,
        id: 9,
        name: "ci",
        headSha: SYNCED,
        status: "completed",
        conclusion: "success",
      });
      return { s, deps: { ...s.deps, carry: { facts: () => carried } } };
    }
    const carriedRequest = { ...request, reviewedHeadSha: SYNCED };

    it("merges the synced head on the carried PASS and ticks from its AC lines", async () => {
      const { s, deps } = behindPr(facts());
      expect(await mergeTaskPr(deps, carriedRequest)).toMatchObject({ status: "done", ticked: 2 });
      expect(s.github.commits.get(s.pull()?.mergeCommitSha ?? "")?.parents).toEqual([BASE, SYNCED]);
    });

    it("refuses a synced head that was edited by hand, and merges nothing", async () => {
      const { s, deps } = behindPr(facts({ headTree: "f".repeat(40) }));
      const result = await mergeTaskPr(deps, carriedRequest);
      expect(result).toMatchObject({ status: "refused", step: "merge" });
      expect(result.status === "refused" ? result.reasons : []).toContain("REVIEW_MISSING");
      expect(s.writes("PUT", "/merge")).toBe(0);
    });

    it("refuses the synced head when the runtime has no carry reader", async () => {
      const { s } = behindPr(facts());
      expect(await mergeTaskPr(s.deps, carriedRequest)).toMatchObject({ status: "refused" });
      expect(s.writes("PUT", "/merge")).toBe(0);
    });
  });

  describe("afterDone", () => {
    it("runs once the task is recorded Done, and a failing follow-up never hides the merge", async () => {
      const s = sandbox();
      const done: string[] = [];
      const afterDone = (taskId: string): Promise<void> => {
        done.push(`${taskId}:${s.task.status}`);
        return Promise.reject(new Error("disk full"));
      };
      expect(await mergeTaskPr({ ...s.deps, afterDone }, request)).toMatchObject({
        status: "done",
      });
      expect(done).toEqual(["task-27:done"]);
    });

    it("is not called when the merge is refused", async () => {
      const s = sandbox();
      const pull = s.pull();
      if (pull !== undefined) pull.headSha = PUSHED;
      const done: string[] = [];
      await mergeTaskPr(
        { ...s.deps, afterDone: (taskId) => Promise.resolve(void done.push(taskId)) },
        request,
      );
      expect(done).toEqual([]);
    });
  });

  it("refuses while another runtime holds the merge lock for develop", async () => {
    const s = sandbox();
    s.deps.leases.acquire({
      resourceKey: `merge-queue:${REPO}:develop`,
      owner: "runtime-2",
      now: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 30_000).toISOString(),
    });
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["MERGE_LOCK_NOT_HELD"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
  });
});
