/**
 * The independent review's verdict on each acceptance criterion, one line per top-level
 * criterion of the Issue (numbered by `acceptanceCriteria` order, starting at 1):
 *
 *   AC-<n>: met|not met — <evidence>
 *
 * The separator may be an em dash, an en dash or `-`/`--`; the evidence must not be empty. A list
 * marker before `AC-` is allowed. A line that starts like a verdict but does not have this shape
 * is malformed, never silently skipped. Review text is data: these lines are the only part of it
 * that a gate reads (AGENTS.md §3).
 */
export type AcVerdict = "met" | "not met";

export interface AcReviewLine {
  readonly number: number;
  /** `undefined` when the line starts like a verdict but is malformed. */
  readonly verdict: AcVerdict | undefined;
}

const LOOKS_LIKE_VERDICT = /^\s*(?:[-*+]\s+)?AC-(\d+)\s*:/;
const VERDICT_LINE = /^\s*(?:[-*+]\s+)?AC-(\d+)\s*:\s*(met|not met)\s*(?:—|–|--?)\s*(\S.*)$/;

/** Every verdict-looking line of a review, in order. */
export function parseAcReviewLines(review: string): readonly AcReviewLine[] {
  const lines: AcReviewLine[] = [];
  for (const line of review.split(/\r?\n/)) {
    const start = LOOKS_LIKE_VERDICT.exec(line);
    if (start?.[1] === undefined) continue;
    const full = VERDICT_LINE.exec(line);
    const verdict = full?.[2] === "met" || full?.[2] === "not met" ? full[2] : undefined;
    lines.push({ number: Number(start[1]), verdict });
  }
  return lines;
}

export type AcceptanceReviewRefusal =
  | "AC_CRITERIA_MISSING"
  | "AC_LINE_MALFORMED"
  | "AC_LINE_UNKNOWN"
  | "AC_LINE_DUPLICATE"
  | "AC_LINE_MISSING"
  | "AC_NOT_MET";

/**
 * Whether the review has exactly one well-formed `met` line for each of `criteriaCount`
 * criteria and nothing else. An Issue without criteria cannot be judged and is refused.
 * Returns every failed reason in priority order.
 */
export function acceptanceReviewRefusals(
  criteriaCount: number,
  lines: readonly AcReviewLine[],
): AcceptanceReviewRefusal[] {
  if (criteriaCount < 1) return ["AC_CRITERIA_MISSING"];
  const refusals: AcceptanceReviewRefusal[] = [];
  if (lines.some((line) => line.verdict === undefined)) refusals.push("AC_LINE_MALFORMED");
  const inRange = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= criteriaCount;
  if (lines.some((line) => !inRange(line.number))) refusals.push("AC_LINE_UNKNOWN");
  const counts = new Map<number, number>();
  for (const line of lines) counts.set(line.number, (counts.get(line.number) ?? 0) + 1);
  if ([...counts.values()].some((count) => count > 1)) refusals.push("AC_LINE_DUPLICATE");
  const numbers = Array.from({ length: criteriaCount }, (_, index) => index + 1);
  if (numbers.some((n) => !counts.has(n))) refusals.push("AC_LINE_MISSING");
  if (lines.some((line) => line.verdict === "not met")) refusals.push("AC_NOT_MET");
  return refusals;
}

/** One unambiguous presentation header; old repository comments may use a SHA prefix. */
export function reviewHeader(
  body: string,
  allowAbbreviated = false,
): { verdict: "PASS" | "FAIL"; head: string } | undefined {
  const headers = body.split(/\r?\n/).filter((line) => line.startsWith("**VERDICT:"));
  if (headers.length !== 1) return undefined;
  const match =
    /^\*\*VERDICT:\*\* (PASS|FAIL) · \*\*REVIEWED_HEAD:\*\* `([0-9a-f]{7,40})`\s*$/.exec(
      headers[0] ?? "",
    );
  const head = match?.[2];
  if (head === undefined || (!allowAbbreviated && head.length !== 40)) return undefined;
  return { verdict: match?.[1] === "PASS" ? "PASS" : "FAIL", head };
}

/** Presentation format only. Posting a comment never records an approval or a runtime review. */
export function reviewCommentRefusals(body: string, head: string, criteriaCount: number): string[] {
  const header = reviewHeader(body);
  const reasons: string[] = [];
  if (header === undefined) reasons.push("REVIEW_HEADER_INVALID");
  else if (header.head !== head) reasons.push("REVIEWED_HEAD_MISMATCH");
  const ac = acceptanceReviewRefusals(criteriaCount, parseAcReviewLines(body));
  return [
    ...reasons,
    ...ac.filter((reason) => reason !== "AC_NOT_MET" || header?.verdict !== "FAIL"),
  ];
}
