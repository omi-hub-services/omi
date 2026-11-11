import { describe, expect, it } from "vitest";
import {
  acceptanceReviewRefusals,
  parseAcReviewLines,
} from "../../../../src/domain/delivery/acceptance-review.ts";

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

  it.each(["AC-1: met", "AC-1: met —", "AC-1: done — x", "AC-1: metric — x", "AC-1 : maybe"])(
    "keeps a malformed verdict line as malformed: %s",
    (line) => {
      expect(parseAcReviewLines(line)).toEqual([{ number: 1, verdict: undefined }]);
    },
  );
});

describe("acceptanceReviewRefusals", () => {
  const refusals = (text: string, count: number) =>
    acceptanceReviewRefusals(count, parseAcReviewLines(text));

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
