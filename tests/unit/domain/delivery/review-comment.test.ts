import { describe, expect, it } from "vitest";
import * as policy from "../../../../src/domain/delivery/acceptance-review.ts";

const head = "a".repeat(40);
const header = `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\``;
const good = `${header}\nAC-1: met — test evidence`;
describe("review comment format", () => {
  it.each([
    [good, []],
    [good.replace("PASS", "FAIL").replace("met —", "not met —"), []],
    [good.replace(head, "b".repeat(40)), ["REVIEWED_HEAD_MISMATCH"]],
    [good.replace(head, head.slice(0, 7)), ["REVIEW_HEADER_INVALID"]],
    ["AC-1: met — evidence", ["REVIEW_HEADER_INVALID"]],
    [`${header}\nAC-1: met`, ["AC_LINE_MALFORMED"]],
    [`${good}\nAC-1: met — twice`, ["AC_LINE_DUPLICATE"]],
    [`${good}\nAC-2: met — extra`, ["AC_LINE_UNKNOWN"]],
    [header, ["AC_LINE_MISSING"]],
    [good.replace("met —", "not met —"), ["AC_NOT_MET"]],
    [`${good}\n${header.replace("PASS", "FAIL")}`, ["REVIEW_HEADER_INVALID"]],
  ])("checks %s", (body, expected) => {
    expect(policy.reviewCommentRefusals(body, head, 1)).toEqual(expected);
  });
});
