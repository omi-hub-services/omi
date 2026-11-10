import { describe, expect, it } from "vitest";
import {
  parseAcLines,
  tickAcceptanceCriteria,
} from "../../../../tools/coordinator/acceptance-criteria.ts";

const BODY = [
  "## Mục tiêu",
  "- [ ] scope box, not an AC",
  "",
  "## Acceptance criteria",
  "- [ ] `flow.ts merge` refuses",
  "  - [ ] nested box counts as AC-2",
  "* [x] already ticked",
  "",
  "### Notes inside the section",
  "- [ ] fourth",
  "",
  "## Implementation map",
  "- [ ] after the section",
  "",
].join("\n");

const met = (n: number) =>
  parseAcLines(
    Array.from({ length: n }, (_, i) => `AC-${String(i + 1)}: met — evidence`).join("\n"),
  );

describe("parseAcLines", () => {
  it("reads one verdict per AC line, with or without a list bullet", () => {
    const review = [
      "**VERDICT:** PASS",
      "AC-1: met — unit test flow-plans.test.ts",
      "- AC-2: not met — no evidence",
      "AC-3: met",
      "see AC-4: met in prose", // not at line start
      "AC-5: metric", // not a verdict word
      "AC-6 met", // no colon
    ].join("\r\n");
    expect([...parseAcLines(review)]).toEqual([
      [1, "met"],
      [2, "not met"],
      [3, "met"],
    ]);
  });

  it("lets a conflicting duplicate line count as not met, in either order", () => {
    expect(parseAcLines("AC-1: met\nAC-1: not met").get(1)).toBe("not met");
    expect(parseAcLines("AC-1: not met\nAC-1: met").get(1)).toBe("not met");
  });
});

describe("tickAcceptanceCriteria", () => {
  it("ticks only the boxes inside the Acceptance criteria section, byte for byte", () => {
    const result = tickAcceptanceCriteria(BODY, met(4));
    expect(result).toMatchObject({ kind: "ok", total: 4, newly: 3 });
    const expected = BODY.replace("- [ ] `flow", "- [x] `flow")
      .replace("  - [ ] nested", "  - [x] nested")
      .replace("- [ ] fourth", "- [x] fourth");
    expect(result.kind === "ok" && result.body).toBe(expected);
    expect(expected).toContain("- [ ] scope box");
    expect(expected).toContain("- [ ] after the section");
  });

  it("is idempotent: a ticked body is returned unchanged with nothing newly ticked", () => {
    const first = tickAcceptanceCriteria(BODY, met(4));
    const body = first.kind === "ok" ? first.body : "";
    expect(tickAcceptanceCriteria(body, met(4))).toEqual({ kind: "ok", body, total: 4, newly: 0 });
  });

  it("keeps CRLF line endings and everything else untouched", () => {
    const crlf = "Intro\r\n## Acceptance Criteria\r\n- [ ] a\r\n- [X] b\r\n\r\nTail";
    const result = tickAcceptanceCriteria(crlf, met(2));
    expect(result.kind === "ok" && result.body).toBe(
      "Intro\r\n## Acceptance Criteria\r\n- [x] a\r\n- [X] b\r\n\r\nTail",
    );
  });

  it.each<[string, string, RegExp]>([
    ["a missing line", "AC-1: met\nAC-2: met\nAC-4: met", /no line for AC-3 \(of 4\)/],
    [
      "more AC lines than criteria",
      "AC-1: met\nAC-2: met\nAC-3: met\nAC-4: met\nAC-5: met",
      /AC-5 but the Issue has 4/,
    ],
    ["AC-0", "AC-0: met", /AC-0 but the Issue has 4/],
    ["a not met AC", "AC-1: met\nAC-2: not met\nAC-3: met\nAC-4: met", /marks AC-2 as not met/],
    ["no AC lines at all", "PASS, looks good", /no line for AC-1, AC-2, AC-3, AC-4/],
  ])("refuses %s and changes nothing", (_label, review, reason) => {
    expect(tickAcceptanceCriteria(BODY, parseAcLines(review))).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(reason) as unknown,
    });
  });

  it("refuses a body without the section or without checkboxes in it", () => {
    expect(tickAcceptanceCriteria("## Scope\n- [ ] x\n", met(1)).kind).toBe("refuse");
    expect(
      tickAcceptanceCriteria("## Acceptance criteria\nnone\n## Next\n- [ ] x", met(1)),
    ).toEqual({ kind: "refuse", reason: "the Acceptance criteria section has no checkboxes" });
  });
});
