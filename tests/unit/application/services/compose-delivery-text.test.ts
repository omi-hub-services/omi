import { describe, expect, it } from "vitest";
import {
  composeCloseComment,
  composeCommitMessage,
  composePrBody,
  composeVerdict,
  layerOf,
  renderPreviousReview,
} from "../../../../src/application/services/compose-delivery-text.js";
import { checkReview } from "../../../../tools/coordinator/review-verdict.ts";
import { linkedIssue } from "../../../../tools/coordinator/review-verdict.ts";

const HEAD = "9d0fba0123456789012345678901234567890abc";
const summary = [
  "Reviewed the fixed revision.",
  "AC-1: met — tests added",
  "- AC-2: met — docs updated",
  "Notes below.",
].join("\n");

describe("composeVerdict", () => {
  it("builds a header and one AC line per criterion that review-comment accepts", () => {
    const made = composeVerdict({ acCount: 2, summary, head: HEAD, status: "succeeded" });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.verdict).toBe("PASS");
    expect(made.text).toContain(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${HEAD}\``);
    expect(checkReview(made.text, { acCount: 2, prHead: HEAD })).toEqual({
      ok: true,
      verdict: "PASS",
      head: HEAD,
    });
  });

  it("is FAIL when a criterion is not met, and still passes the review-comment check", () => {
    const made = composeVerdict({
      acCount: 2,
      summary: "AC-1: met — a\nAC-2: not met — b",
      head: HEAD,
      status: "succeeded",
    });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.verdict).toBe("FAIL");
    expect(checkReview(made.text, { acCount: 2, prHead: HEAD }).ok).toBe(true);
  });

  it("refuses when the report lacks a line for a criterion", () => {
    const made = composeVerdict({
      acCount: 3,
      summary,
      head: HEAD,
      status: "succeeded",
    });
    expect(made.ok).toBe(false);
    expect(made.ok ? [] : made.reasons.join(" ")).toMatch(/no line for AC-3/);
  });

  it.each([
    ["a malformed line", "AC-1: met\nAC-2: met — b"],
    ["a repeated line", "AC-1: met — a\nAC-1: met — a\nAC-2: met — b"],
    ["an unknown criterion", "AC-1: met — a\nAC-2: met — b\nAC-3: met — c"],
  ])("refuses %s", (_name, text) => {
    expect(composeVerdict({ acCount: 2, summary: text, head: HEAD, status: "succeeded" }).ok).toBe(
      false,
    );
  });

  it("is FAIL when the review step itself failed", () => {
    const made = composeVerdict({
      acCount: 2,
      summary: "AC-1: met — a\nAC-2: met — b",
      head: HEAD,
      status: "failed",
    });
    expect(made.ok && made.verdict).toBe("FAIL");
  });
});

describe("composeCommitMessage", () => {
  const trailer = "Co-Authored-By: Claude <noreply@example.invalid>";

  it("takes the Proposed commit line and appends the trailer", () => {
    const made = composeCommitMessage(
      "Files...\nProposed commit: feat(tools): compose text (OMI-185)\nUnverified: none",
      trailer,
    );
    expect(made).toEqual({
      ok: true,
      message: `feat(tools): compose text (OMI-185)\n\n${trailer}\n`,
    });
  });

  it("accepts a list marker, bold label and backticks", () => {
    const made = composeCommitMessage("- **Proposed commit:** `fix: x (OMI-1)`", trailer);
    expect(made.ok && made.message).toBe(`fix: x (OMI-1)\n\n${trailer}\n`);
  });

  it("does not repeat a trailer the line already carries", () => {
    const made = composeCommitMessage(`Proposed commit: fix: x (OMI-1) ${trailer}`, trailer);
    expect(made.ok && made.message.split(trailer).length).toBe(2);
  });

  it("refuses an empty Proposed commit line instead of taking the next line", () => {
    expect(composeCommitMessage("Proposed commit:\nUnverified: none", trailer).ok).toBe(false);
    expect(composeCommitMessage("Proposed commit:  \n\nfeat: stray (OMI-1)", trailer).ok).toBe(
      false,
    );
  });

  it.each([
    "no such line",
    "Proposed commit message ending (OMI-185), using the Plan Key",
    "Proposed commit:   ",
  ])("refuses a report without a usable line: %s", (text) => {
    expect(composeCommitMessage(text, trailer).ok).toBe(false);
  });
});

describe("composePrBody", () => {
  const files = ["src/application/services/a.ts", "tests/unit/a.test.ts", "tools/coordinator/x.ts"];
  const body = composePrBody({
    issue: 378,
    files,
    head: HEAD,
    check: { command: "npm run check", log: "all green" },
    notes: "Coordinator says hi.",
  });

  it("carries the Issue link the PR gate reads, the layer table, evidence and notes", () => {
    expect(linkedIssue(body)).toBe(378);
    expect(body).toContain("| `src/application/services/a.ts` | application |");
    expect(body).toContain("| `tests/unit/a.test.ts` | tests (unit) |");
    expect(body).toContain("| `tools/coordinator/x.ts` | coordinator tooling |");
    expect(body).toContain(`\`npm run check\` passed on \`${HEAD}\``);
    expect(body).toContain("all green");
    expect(body).toContain("Coordinator says hi.");
  });

  it("omits the notes section when there are no notes", () => {
    expect(
      composePrBody({ issue: 1, files, head: HEAD, check: { command: "c", log: "l" } }),
    ).not.toContain("Coordinator notes");
  });

  it("maps paths to layers from the folder map", () => {
    expect(layerOf("src/domain/x.ts")).toBe("domain");
    expect(layerOf("src/interfaces/cli/a.ts")).toBe("interfaces");
    expect(layerOf("templates/bridges/a.md")).toBe("templates");
    expect(layerOf("docs/a.md")).toBe("docs");
    expect(layerOf("package.json")).toBe("root");
  });
});

describe("composeCloseComment", () => {
  it("names the PR, merge commit, required checks and the verdict line", () => {
    const text = composeCloseComment({
      issue: 378,
      pr: 380,
      mergeCommit: "a".repeat(40),
      requiredChecks: ["check", "lint"],
      verdict: { verdict: "PASS", head: HEAD },
    });
    expect(text).toContain("PR #380");
    expect(text).toContain("a".repeat(40));
    expect(text).toContain("check, lint");
    expect(text).toContain(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${HEAD}\``);
  });
});

describe("renderPreviousReview", () => {
  it("keeps the round, head, summary and findings of the earlier review", () => {
    const text = renderPreviousReview({
      round: 1,
      status: "failed",
      head: HEAD,
      summary: "AC-1: not met — x",
      findings: ["- [major] F1: bad"],
    });
    expect(text).toContain("round 1");
    expect(text).toContain(HEAD);
    expect(text).toContain("AC-1: not met — x");
    expect(text).toContain("- [major] F1: bad");
  });
});
