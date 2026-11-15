// Acceptance criteria of an Issue body and the independent reviewer's verdict lines
// (omi-next step 5), one per criterion:
//   AC-<n>: met|not met — <evidence>
// numbered by the order of the criteria under the body's `## Acceptance criteria` heading (up to
// the next `#`/`##` heading). Counting convention (OMI-052; omi-next step 5 tells the reviewer):
// only top-level checkboxes (list marker in column 0) directly under that heading are criteria;
// nested checkboxes, checkboxes inside a ``` or ~~~ code fence, and everything below a sub-heading
// (`###` or deeper) in the section are not. Ticking changes only `[ ]` to `[x]` on criterion
// lines; every other byte of the body stays as it was.

import "../register-ts-imports.ts";
const { acceptanceCriteria, tickAcceptanceCriteria: tickCriteria } =
  await import("../../src/domain/tasks/acceptance-criteria.ts");

const { parseAcReviewLines } = await import("../../src/domain/delivery/acceptance-review.ts");
const AC_LINE = /^\s*(?:[-*+]\s+)?AC-(\d+):\s*(met|not met)\b/;

/** The `AC-<n>: met|not met` lines of a review, verbatim and in order (carried PASS copies them). */
export function acLines(review: string): string[] {
  return review.split("\n").filter((line) => AC_LINE.test(line));
}

export type AcVerdict = "met" | "not met";

/** AC number -> verdict. Malformed or repeated evidence counts as not met (fail closed). */
export function parseAcLines(review: string): Map<number, AcVerdict> {
  const out = new Map<number, AcVerdict>();
  for (const line of parseAcReviewLines(review)) {
    out.set(line.number, out.has(line.number) ? "not met" : (line.verdict ?? "not met"));
  }
  return out;
}

export type TickResult =
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "ok"; readonly body: string; readonly total: number; readonly newly: number };

const list = (ns: readonly number[]) => ns.map((n) => `AC-${String(n)}`).join(", ");

/** Uses the same top-level counting convention as closing evidence. */
export function countAcceptanceCriteria(body: string): number {
  return extractAcceptanceCriteria(body).length;
}

/** Criterion text in verdict-number order, using the same parser as ticking and counting. */
export function extractAcceptanceCriteria(body: string): string[] {
  return [...acceptanceCriteria(body)];
}

/** Ticks every criterion when the review has a `met` line for each and nothing else. */
export function tickAcceptanceCriteria(
  body: string,
  verdicts: ReadonlyMap<number, AcVerdict>,
): TickResult {
  const refuse = (reason: string): TickResult => ({ kind: "refuse", reason });
  const criteria = acceptanceCriteria(body);
  if (!/^##\s+Acceptance criteria\s*$/im.test(body))
    return refuse('the Issue body has no "## Acceptance criteria" section');
  if (criteria.length === 0) return refuse("the Acceptance criteria section has no checkboxes");
  const boxes = criteria;
  const numbers = boxes.map((_, i) => i + 1);
  const total = String(boxes.length);
  const unknown = [...verdicts.keys()].filter((k) => k < 1 || k > boxes.length);
  if (unknown.length > 0) {
    return refuse(`the review has ${list(unknown)} but the Issue has ${total} criteria`);
  }
  const missing = numbers.filter((k) => !verdicts.has(k));
  if (missing.length > 0)
    return refuse(`the review has no line for ${list(missing)} (of ${total})`);
  const notMet = numbers.filter((k) => verdicts.get(k) === "not met");
  if (notMet.length > 0) return refuse(`the review marks ${list(notMet)} as not met`);
  return { kind: "ok", ...tickCriteria(body) };
}
