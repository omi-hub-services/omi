import { describe, expect, it } from "vitest";
import {
  acceptanceReviewRefusals,
  hasSecuritySection,
  parseAcReviewLines,
} from "../../../../src/domain/delivery/acceptance-review.ts";

describe("hasSecuritySection", () => {
  it.each([
    "Security: checked — no exec added",
    "**Security:** no findings - diff has no input handling",
    "## Security:\n- secrets: no findings: grep of the diff found none",
    "- Security:\n  trust boundaries: checked — src/x.ts:4\n## Verdict:\nready",
  ])("accepts a section with a status and evidence: %s", (body) => {
    expect(hasSecuritySection(`AC-1: met — x\n${body}`)).toBe(true);
  });
  it.each([
    "AC-1: met — x",
    "AC-1: met — Security: covered by a test",
    "Security:",
    "**Security:**\n\n",
    "Insecurity: none",
    "Security:\n\n## Verdict:\nready",
    "Security:\n## Verdict:\n- trust boundaries: checked — evidence outside the section",
    "Security: TODO",
    "Security: checked — TBD",
    "Security:\n- secrets: no findings — n/a",
    "Security:\n- secrets: no findings — -",
    "Security:\n- secrets: ok",
    "Security:\n- secrets: checked",
  ])("refuses a missing or empty section: %s", (body) => {
    expect(hasSecuritySection(body)).toBe(false);
  });
});

describe("parseAcReviewLines", () => {
  it("reads each verdict line with any accepted separator and an optional list marker", () => {
    expect(
      parseAcReviewLines(
        [
          "**VERDICT:** PASS",
          "AC-1: met — tests/unit/a.test.ts",
          "- AC-2: not met – no e2e test",
          "* AC-3: met - contract test",
          "AC-4: met -- integration test\r",
          "Prose that mentions AC-5: met inline is not a verdict line.",
        ].join("\n"),
      ),
    ).toEqual([
      { number: 1, verdict: "met" },
      { number: 2, verdict: "not met" },
      { number: 3, verdict: "met" },
      { number: 4, verdict: "met" },
    ]);
  });

  it("parses deferred only with an explicit allowance", () => {
    expect(parseAcReviewLines("AC-1: deferred — tag after merge", true)).toEqual([
      { number: 1, verdict: "deferred" },
    ]);
  });

  it.each([
    "AC-1: deferred — tag after merge",
    "AC-1: met",
    "AC-1: met —",
    "AC-1: done — x",
    "AC-1: metric — x",
    "AC-1 : maybe",
  ])("keeps a malformed verdict line as malformed: %s", (line) => {
    expect(parseAcReviewLines(line)).toEqual([{ number: 1, verdict: undefined }]);
  });
});

describe("acceptanceReviewRefusals", () => {
  const refusals = (text: string, count: number) =>
    acceptanceReviewRefusals(count, parseAcReviewLines(text));

  it("keeps runtime gates strict even for explicitly parsed deferred lines", () => {
    expect(acceptanceReviewRefusals(1, parseAcReviewLines("AC-1: deferred — tag", true))).toEqual([
      "AC_NOT_MET",
    ]);
  });

  it("passes with exactly one met line per criterion", () => {
    expect(refusals("AC-2: met — b\nAC-1: met — a", 2)).toEqual([]);
  });

  it("reports every problem at once, in priority order", () => {
    expect(refusals("AC-1: met\nAC-3: not met — c\nAC-3: met — c", 2)).toEqual([
      "AC_LINE_MALFORMED",
      "AC_LINE_UNKNOWN",
      "AC_LINE_DUPLICATE",
      "AC_LINE_MISSING",
      "AC_NOT_MET",
    ]);
  });

  it("treats AC-0 as unknown, never as a criterion", () => {
    expect(refusals("AC-0: met — x\nAC-1: met — a", 1)).toEqual(["AC_LINE_UNKNOWN"]);
  });

  it("refuses an Issue without criteria regardless of the review", () => {
    expect(refusals("AC-1: met — a", 0)).toEqual(["AC_CRITERIA_MISSING"]);
  });
});
