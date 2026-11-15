import { describe, expect, it } from "vitest";
import {
  checkReview,
  linkedIssue,
  securityReviewRisk,
  type ReviewCheck,
} from "../../../../tools/coordinator/review-verdict.ts";

const HEAD = "9d0fba0123456789012345678901234567890abc";
const verdict = (v = "PASS", sha = "9d0fba0") =>
  `**VERDICT:** ${v} · **REVIEWED_HEAD:** \`${sha}\``;
const ctx = { acCount: 2, prHead: HEAD };
const why = (r: ReviewCheck) => (r.ok ? "" : r.reasons.join(" "));
const good = `${verdict()}\n\nAC-1: met — tests added\nAC-2: met — docs updated\n\nNotes.`;

describe("security review", () => {
  const security = { ...ctx, securityRisk: true };
  const section = `${good}\n\nSecurity:\n- Command injection: checked — argv array at src/x.ts:4`;

  it("refuses a security-relevant PASS or FAIL without a Security: section", () => {
    expect(why(checkReview(good, security))).toMatch(/Security:/);
    const fail = `${verdict("FAIL")}\nAC-1: met — a\nAC-2: not met — b`;
    expect(checkReview(fail, security).ok).toBe(false);
    expect(why(checkReview(`${good}\nSecurity:\n`, security))).toMatch(/Security:/);
  });

  it.each(["Security:\n\n## Verdict:\nready", "Security: TODO", "Security:\n- secrets: checked"])(
    "refuses a heading-only, placeholder or evidence-less section: %s",
    (tail) => {
      expect(why(checkReview(`${good}\n${tail}`, security))).toMatch(/Security:/);
    },
  );

  it("accepts a security-relevant review with a Security: section", () => {
    expect(checkReview(section, security)).toEqual({ ok: true, verdict: "PASS", head: "9d0fba0" });
  });

  it("does not ask for the section without the security risk", () => {
    expect(checkReview(good, ctx).ok).toBe(true);
    expect(checkReview(good, { ...ctx, securityRisk: false }).ok).toBe(true);
  });

  it("derives the risk from the Issue paths, the Area or --risk security", () => {
    const body = (path: string) => `## Implementation map\n- ${path}\n`;
    expect(securityReviewRisk(body("src/infrastructure/process/exec-runner.ts"), null)).toBe(true);
    expect(securityReviewRisk(body("src/interfaces/cli/commands/task.ts"), null)).toBe(false);
    expect(securityReviewRisk(body("src/interfaces/cli/commands/task.ts"), "security")).toBe(true);
    expect(securityReviewRisk(body("src/interfaces/cli/commands/task.ts"), null, "gates")).toBe(
      false,
    );
    expect(
      securityReviewRisk(body("src/interfaces/cli/commands/task.ts"), null, "data,security"),
    ).toBe(true);
  });
});

describe("checkReview", () => {
  it("requires script regression evidence for a passing bugfix review", () => {
    const forkPoint = "b".repeat(40);
    const bugfix = { ...ctx, workflow: "bugfix", forkPoint };
    expect(checkReview(good, bugfix).ok).toBe(false);
    const regressionEvidence = {
      base: { revision: forkPoint, command: ["npm", "test"], exitCode: 1 },
      head: { revision: HEAD, command: ["npm", "test"], exitCode: 0 },
    };
    expect(checkReview(good, { ...bugfix, regressionEvidence }).ok).toBe(true);
    expect(checkReview(good, { ...bugfix, forkPoint: HEAD, regressionEvidence }).ok).toBe(false);
    expect(checkReview(good, { ...bugfix, forkPoint: undefined, regressionEvidence }).ok).toBe(
      false,
    );
  });

  it("accepts bugfix regression evidence recorded on the fork point after the base advanced", () => {
    const forkPoint = "a".repeat(40);
    const baseTip = "b".repeat(40);
    const bugfix = { ...ctx, workflow: "bugfix", forkPoint };
    const evidence = (revision: string) => ({
      base: { revision, command: ["npm", "test"], exitCode: 1 },
      head: { revision: HEAD, command: ["npm", "test"], exitCode: 0 },
    });
    expect(checkReview(good, { ...bugfix, regressionEvidence: evidence(forkPoint) }).ok).toBe(true);
    expect(checkReview(good, { ...bugfix, regressionEvidence: evidence("c".repeat(40)) }).ok).toBe(
      false,
    );
    expect(checkReview(good, { ...bugfix, regressionEvidence: evidence(baseTip) }).ok).toBe(false);
  });

  it("accepts PASS with every AC met on the PR head", () => {
    expect(checkReview(good, ctx)).toEqual({ ok: true, verdict: "PASS", head: "9d0fba0" });
  });

  it("accepts a release-workflow PASS with PO and post-merge AC deferred to Coordinator steps", () => {
    const releaseContext = { acCount: 3, prHead: HEAD, workflow: "release" };
    const body = `${verdict()}
AC-1: met — release diff independently reviewed on the PR head
AC-2: deferred — PO native approval before merge
AC-3: deferred — tag and Release assets after merge`;

    expect(checkReview(body, releaseContext)).toEqual({
      ok: true,
      verdict: "PASS",
      head: "9d0fba0",
    });
  });

  it.each(["feature", "bugfix", "docs", "deploy", undefined])(
    "refuses deferred AC for workflow %s",
    (workflow) => {
      const body = `${verdict()}\nAC-1: met — tests\nAC-2: deferred — tag after merge`;
      expect(checkReview(body, { ...ctx, workflow }).ok).toBe(false);
    },
  );

  it("still refuses a release PASS with an unmet criterion", () => {
    const body = `${verdict()}\nAC-1: not met — failing checks\nAC-2: deferred — tag after merge`;
    expect(why(checkReview(body, { ...ctx, workflow: "release" }))).toMatch(/PASS.*AC-1/);
  });

  it("requires a Coordinator step after deferred", () => {
    const body = `${verdict()}\nAC-1: met — tests\nAC-2: deferred —`;
    expect(checkReview(body, { ...ctx, workflow: "release" }).ok).toBe(false);
  });

  it("accepts a full SHA that equals the head", () => {
    expect(checkReview(good.replace("9d0fba0", HEAD), ctx).ok).toBe(true);
  });

  it("accepts FAIL with an AC not met", () => {
    const body = `${verdict("FAIL")}\nAC-1: met — ok\nAC-2: not met — nothing written`;
    expect(checkReview(body, ctx)).toMatchObject({ ok: true, verdict: "FAIL" });
  });

  it("refuses a body without the VERDICT line", () => {
    const r = checkReview("AC-1: met — a\nAC-2: met — b", ctx);
    expect(r).toMatchObject({ ok: false });
    expect(why(r)).toMatch(/VERDICT/);
  });

  it("refuses a VERDICT other than PASS or FAIL, or without the REVIEWED_HEAD part", () => {
    expect(checkReview(`${verdict("MAYBE")}\nAC-1: met — a\nAC-2: met — b`, ctx).ok).toBe(false);
    expect(checkReview("**VERDICT:** PASS\nAC-1: met — a\nAC-2: met — b", ctx).ok).toBe(false);
  });

  it("refuses a REVIEWED_HEAD that is not the PR head", () => {
    const r = checkReview(good.replace("9d0fba0", "1234567"), ctx);
    expect(why(r)).toMatch(/REVIEWED_HEAD/);
  });

  it("refuses a missing AC line, naming it", () => {
    const r = checkReview(`${verdict()}\nAC-1: met — a`, ctx);
    expect(why(r)).toMatch(/AC-2/);
  });

  it("refuses an AC line the Issue does not have", () => {
    const r = checkReview(`${good}\nAC-3: met — extra`, ctx);
    expect(why(r)).toMatch(/AC-3/);
  });

  it("refuses two lines for one AC, even if they agree", () => {
    const r = checkReview(`${good}\nAC-1: met — again`, ctx);
    expect(why(r)).toMatch(/AC-1.*more than once|twice/);
  });

  it("refuses an AC line without an em dash and evidence", () => {
    const r = checkReview(`${verdict()}\nAC-1: met\nAC-2: met — b`, ctx);
    expect(why(r)).toMatch(/AC-1.*evidence/);
  });

  it("refuses PASS when any AC is not met", () => {
    const r = checkReview(`${verdict()}\nAC-1: met — a\nAC-2: not met — missing`, ctx);
    expect(why(r)).toMatch(/PASS.*AC-2/);
  });

  it("collects every reason instead of stopping at the first", () => {
    const r = checkReview("nothing useful", ctx);
    expect(why(r).length).toBeGreaterThanOrEqual(2);
  });

  it("takes the AC count from the Issue, so an Issue with no AC cannot be reviewed", () => {
    expect(checkReview(verdict(), { acCount: 0, prHead: HEAD }).ok).toBe(false);
  });
});

describe("linkedIssue", () => {
  it("reads the Issue number of the `Issue: #N` line of a PR body", () => {
    expect(linkedIssue("Changes\n\nIssue: #159\n")).toBe(159);
  });

  it("is null without such a line or with a closing keyword only", () => {
    expect(linkedIssue("Closes #159")).toBeNull();
    expect(linkedIssue("")).toBeNull();
  });
});
