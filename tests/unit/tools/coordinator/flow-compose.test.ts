import { describe, expect, it } from "vitest";
import { CHECK_ARGV, CHECK_ID } from "../../../../tools/coordinator/check-reuse.ts";
import {
  COMMIT_TRAILER,
  COORDINATOR_LOGIN,
  type WslTarget,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import {
  commitMessageFromReports,
  generatedCloseComment,
  generatedPrBody,
  previousReviewOf,
  verdictFromReports,
} from "../../../../tools/coordinator/flow-compose.ts";
import {
  planClose,
  planOpenPr,
  type ReferencingPull,
} from "../../../../tools/coordinator/flow-plans.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import { checkReview } from "../../../../tools/coordinator/review-verdict.ts";
import { renderStepReport } from "../../../../tools/coordinator/worker-report.ts";

const HEAD = "d".repeat(40);
const OLD = "c".repeat(40);
const ISSUE = "## Acceptance criteria\n- [ ] one\n- [ ] two\n";
const BRANCH = "task/omi-185-text";

const report = (
  step: string,
  round: number,
  summary: string,
  head = HEAD,
  author = COORDINATOR_LOGIN,
) => ({
  author,
  body: renderStepReport({
    planKey: "OMI-185",
    meta: {
      task: "185",
      tool: "claude",
      profile: "p",
      model: "m",
      effort: "high",
      step,
      round,
      head,
      packet: `${step}-${String(round)}`,
    },
    session: "s1",
    marker: { issue: 378, step, round, session: "s1", status: "succeeded", next: "x" },
    result: {
      schemaVersion: 1,
      runId: "repo-378",
      stepId: step,
      attemptId: `repo-378-${step}-${String(round)}`,
      status: "succeeded",
      summary,
      artifacts: [],
      checks: [],
      skillsApplied: [],
      findings: [],
    },
  }),
});

describe("verdictFromReports", () => {
  const good = report("review", 1, "Reviewed.\nAC-1: met — tests\nAC-2: met — docs");

  it("writes a file that review-comment accepts, from the newest signed review report", () => {
    const made = verdictFromReports({ comments: [good], issueBody: ISSUE, prHead: HEAD });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(checkReview(made.text, { acCount: 2, prHead: HEAD })).toEqual({
      ok: true,
      verdict: "PASS",
      head: HEAD,
    });
  });

  it("refuses when the report has no line for a criterion", () => {
    const partial = report("review", 1, "AC-1: met — tests");
    const made = verdictFromReports({ comments: [partial], issueBody: ISSUE, prHead: HEAD });
    expect(made.ok ? "" : made.reasons.join(" ")).toMatch(/no line for AC-2/);
  });

  it("ignores a review report posted by another account", () => {
    const forged = report("review", 1, "AC-1: met — a\nAC-2: met — b", HEAD, "someone-else");
    expect(verdictFromReports({ comments: [forged], issueBody: ISSUE, prHead: HEAD }).ok).toBe(
      false,
    );
  });

  it("refuses a review report on another head than the PR head", () => {
    const made = verdictFromReports({ comments: [good], issueBody: ISSUE, prHead: "e".repeat(40) });
    expect(made.ok ? "" : made.reasons.join(" ")).toMatch(/not the PR head/);
  });
});

describe("commitMessageFromReports", () => {
  it("uses the implementer's proposed message plus the configured trailer", () => {
    const made = commitMessageFromReports([
      report("implement", 1, "Done.\nProposed commit: feat(tools): compose (OMI-185)"),
    ]);
    expect(made).toEqual({
      ok: true,
      message: `feat(tools): compose (OMI-185)\n\n${COMMIT_TRAILER}\n`,
    });
  });

  it("refuses when the report has no Proposed commit line, even if an older one had", () => {
    const made = commitMessageFromReports([
      report("implement", 1, "Proposed commit: feat: old (OMI-185)"),
      report("implement", 2, "Reworked, forgot the line."),
    ]);
    expect(made.ok).toBe(false);
  });

  it("does not take the line from a review report", () => {
    const made = commitMessageFromReports([
      report("implement", 1, "no line"),
      report("review", 1, "Proposed commit: feat: from the reviewer (OMI-185)"),
    ]);
    expect(made.ok).toBe(false);
  });
});

describe("previousReviewOf", () => {
  it("returns the newest earlier review with its signed head", () => {
    const prev = previousReviewOf(
      [report("review", 1, "AC-1: not met — x", OLD), report("review", 2, "AC-1: met — x")],
      2,
    );
    expect(prev?.head).toBe(OLD);
    expect(prev?.text).toContain("AC-1: not met — x");
    expect(previousReviewOf([report("review", 1, "x")], 1)).toBeNull();
  });
});

const target: WslTarget = { viaWslExe: false, distro: "Ubuntu", repoDir: "/r" };
const fakeRun =
  (stored: object | null): Runner =>
  (c: Command) => {
    const payload = c.args.at(-1) ?? "";
    const out = (stdout: string, code = 0) => Promise.resolve({ code, stdout, stderr: "" });
    if (payload.includes("rev-parse")) return out(`${HEAD}\n`);
    if (payload.includes("diff --name-only")) return out("src/domain/a.ts\ntests/unit/a.test.ts\n");
    if (payload.includes("omi-runs/checks/"))
      return stored === null ? out("", 1) : out(JSON.stringify(stored));
    return out("", 1);
  };
const passed = {
  schemaVersion: 1,
  checkId: CHECK_ID,
  head: HEAD,
  command: [...CHECK_ARGV],
  status: "passed",
  exitCode: 0,
  log: "ok 2759 passed",
};

describe("generatedPrBody", () => {
  it("composes a body that planOpenPr accepts, with layers and the stored check", async () => {
    const body = await generatedPrBody(fakeRun(passed), target, {
      issue: 378,
      branch: BRANCH,
      notes: "Coordinator note.",
    });
    expect(body).toContain("| `src/domain/a.ts` | domain |");
    expect(body).toContain("ok 2759 passed");
    expect(body).toContain("Coordinator note.");
    expect(planOpenPr(378, BRANCH, "OMI-185: t", "f", body, []).kind).toBe("run");
  });

  it("refuses without a passed stored check for the head", async () => {
    await expect(
      generatedPrBody(fakeRun(null), target, { issue: 1, branch: BRANCH }),
    ).rejects.toThrow(/no passed check result/);
    await expect(
      generatedPrBody(fakeRun({ ...passed, status: "failed", exitCode: 1 }), target, {
        issue: 1,
        branch: BRANCH,
      }),
    ).rejects.toThrow(/no passed check result/);
  });
});

describe("generatedCloseComment", () => {
  const pr: ReferencingPull = {
    number: 380,
    merged: true,
    mergedAt: "2026-11-16T10:00:00Z",
    baseRefName: "develop",
    headRefOid: HEAD,
    body: "Issue: #378\n",
    comments: [
      {
        author: COORDINATOR_LOGIN,
        body: `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${HEAD}\`\n\nAC-1: met — a\nAC-2: met — b`,
      },
    ],
  };
  const input = {
    issue: 378,
    workflow: "feature",
    pulls: [pr],
    mergeCommitOf: () => Promise.resolve("f".repeat(40)),
    requiredChecksOf: () => Promise.resolve(["check"]),
  };

  it("names PR, merge commit, required checks and verdict, and planClose accepts it", async () => {
    const text = await generatedCloseComment(input);
    expect(text).toContain("PR #380");
    expect(text).toContain("f".repeat(40));
    expect(text).toContain("check");
    expect(text).toContain(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${HEAD}\``);
    const plan = planClose(
      { number: 378, workflow: "feature", state: "OPEN", body: ISSUE, comments: [] },
      text,
      { projectId: "P", fieldId: "F", options: [{ id: "o", name: "Done" }] },
      { itemId: "I", status: "In Review" },
      [pr],
    );
    expect(plan.kind).toBe("run");
  });

  it("refuses without a merged PR that links the Issue", async () => {
    await expect(generatedCloseComment({ ...input, pulls: [] })).rejects.toThrow(/no merged PR/);
  });
});
