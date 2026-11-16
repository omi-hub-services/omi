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
export type AcVerdict = "met" | "not met" | "deferred";

export interface AcReviewLine {
  readonly number: number;
  /** `undefined` when the line starts like a verdict but is malformed. */
  readonly verdict: AcVerdict | undefined;
}

const LOOKS_LIKE_VERDICT = /^\s*(?:[-*+]\s+)?AC-(\d+)\s*:/;
const VERDICT_LINE =
  /^\s*(?:[-*+]\s+)?AC-(\d+)\s*:\s*(met|not met|deferred)\s*(?:—|–|--?)\s*(\S.*)$/;

/** Every verdict-looking line, in order. Deferred is opt-in for repository release review only. */
export function parseAcReviewLines(review: string, allowDeferred = false): readonly AcReviewLine[] {
  const lines: AcReviewLine[] = [];
  for (const line of review.split(/\r?\n/)) {
    const start = LOOKS_LIKE_VERDICT.exec(line);
    if (start?.[1] === undefined) continue;
    const full = VERDICT_LINE.exec(line);
    const value = full?.[2];
    const verdict =
      value === "met" || value === "not met" || (allowDeferred && value === "deferred")
        ? value
        : undefined;
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
  if (lines.some((line) => line.verdict === "not met" || line.verdict === "deferred"))
    refusals.push("AC_NOT_MET");
  return refusals;
}

const SECURITY_HEADING = /^\s*(?:#{1,6}\s+)?(?:[-*+]\s+)?\**Security:\**(.*)$/i;

/** Ends the section: the next Markdown heading, or the review's other well-known parts. */
const SECTION_END =
  /^\s*(?:#{1,6}\s|\**(?:VERDICT|Verdict|Not checked|Must fix|Should fix|Nice to have|What this change does)\b|(?:[-*+]\s+)?AC-\d+\s*:)/;
/** `checked` or `no findings`, then a separator and non-empty evidence. */
const AREA_STATUS = /\b(?:checked|no findings)\b\s*(?:—|–|--?|:)\s*(\S.*)$/i;
const PLACEHOLDER = /^(?:todo|tbd|n\/?a|none|nothing|-+|\.+|\?+)\W*$/i;

/** The `Security:` heading line and the lines under it up to the section end; empty when absent. */
export function securitySectionLines(review: string): string[] {
  const lines = review.split(/\r?\n/);
  const at = lines.findIndex((line) => SECURITY_HEADING.test(line));
  if (at < 0) return [];
  const section = [lines[at] ?? ""];
  for (const line of lines.slice(at + 1)) {
    if (SECTION_END.test(line)) break;
    section.push(line);
  }
  return section;
}

/**
 * Whether a security-relevant review has a bounded `Security:` section (up to the next heading or
 * review part) with at least one area line saying `checked` or `no findings` plus real evidence.
 * Empty, heading-only and placeholder sections (TODO, TBD, n/a, `-`) are refused. Whether the
 * evidence is true stays the reviewer's and the Coordinator's judgment.
 */
export function hasSecuritySection(review: string): boolean {
  const raw = securitySectionLines(review);
  if (raw.length === 0) return false;
  const section = [SECURITY_HEADING.exec(raw[0] ?? "")?.[1] ?? "", ...raw.slice(1)];
  return section.some((line) => {
    const evidence = AREA_STATUS.exec(line)?.[1]?.trim();
    return evidence !== undefined && !PLACEHOLDER.test(evidence);
  });
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
