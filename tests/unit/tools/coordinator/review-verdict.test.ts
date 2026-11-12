import { describe, expect, it } from "vitest";
import {
  checkReview,
  linkedIssue,
  type ReviewCheck,
} from "../../../../tools/coordinator/review-verdict.ts";

const HEAD = "9d0fba0123456789012345678901234567890abc";
const verdict = (v = "PASS", sha = "9d0fba0") =>
  `**VERDICT:** ${v} · **REVIEWED_HEAD:** \`${sha}\``;
const ctx = { acCount: 2, prHead: HEAD };
const why = (r: ReviewCheck) => (r.ok ? "" : r.reasons.join(" "));
const good = `${verdict()}\n\nAC-1: met — tests added\nAC-2: met — docs updated\n\nNotes.`;

describe("checkReview", () => {
  it("accepts PASS with every AC met on the PR head", () => {
    expect(checkReview(good, ctx)).toEqual({ ok: true, verdict: "PASS", head: "9d0fba0" });
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
