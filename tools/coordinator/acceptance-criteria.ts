// Acceptance criteria of an Issue body and the independent reviewer's verdict lines
// (omi-next step 5), one per criterion:
//   AC-<n>: met|not met — <evidence>
// numbered by the order of the criteria under the body's `## Acceptance criteria` heading (up to
// the next `#`/`##` heading). Counting convention (OMI-052; omi-next step 5 tells the reviewer):
// only top-level checkboxes (list marker in column 0) directly under that heading are criteria;
// nested checkboxes, checkboxes inside a ``` or ~~~ code fence, and everything below a sub-heading
// (`###` or deeper) in the section are not. Ticking changes only `[ ]` to `[x]` on criterion
// lines; every other byte of the body stays as it was.

const HEADING = /^##\s+Acceptance criteria\s*$/i;
const SECTION_END = /^#{1,2}\s/;
const SUB_HEADING = /^#{3,6}\s/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CHECKBOX = /^([-*+]\s+\[)([ xX])\]/;

/** Line indexes of the criteria in `lines` (see the counting convention above). */
function criterionLines(lines: readonly string[], start: number): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r?\n$/, "");
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      // A fence closes with the same character, at least as long, and nothing after it.
      const closes =
        marker !== undefined && marker.startsWith(fence[0] ?? "") && marker.length >= fence.length;
      if (closes && line.trim() === marker) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (SECTION_END.test(line) || SUB_HEADING.test(line)) break;
    if (CHECKBOX.test(line)) out.push(i);
  }
  return out;
}
const AC_LINE = /^\s*(?:[-*+]\s+)?AC-(\d+):\s*(met|not met)\b/;

/** The `AC-<n>: met|not met` lines of a review, verbatim and in order (carried PASS copies them). */
export function acLines(review: string): string[] {
  return review.split("\n").filter((line) => AC_LINE.test(line));
}

export type AcVerdict = "met" | "not met";

/** AC number -> verdict. A criterion with conflicting lines counts as not met. */
export function parseAcLines(review: string): Map<number, AcVerdict> {
  const out = new Map<number, AcVerdict>();
  for (const line of review.split("\n")) {
    const m = AC_LINE.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const n = Number(m[1]);
    if (out.get(n) !== "not met") out.set(n, m[2] === "met" ? "met" : "not met");
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
  const lines = body.split(/(?<=\n)/);
  const start = lines.findIndex((line) => HEADING.test(line));
  return start === -1
    ? []
    : criterionLines(lines, start).map((i) =>
        (lines[i] ?? "")
          .replace(CHECKBOX, "")
          .replace(/^\s+/, "")
          .replace(/\r?\n$/, ""),
      );
}

/** Ticks every criterion when the review has a `met` line for each and nothing else. */
export function tickAcceptanceCriteria(
  body: string,
  verdicts: ReadonlyMap<number, AcVerdict>,
): TickResult {
  const refuse = (reason: string): TickResult => ({ kind: "refuse", reason });
  const lines = body.split(/(?<=\n)/);
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start === -1) return refuse('the Issue body has no "## Acceptance criteria" section');
  const boxes = criterionLines(lines, start);
  if (boxes.length === 0) return refuse("the Acceptance criteria section has no checkboxes");
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
  let newly = 0;
  for (const i of boxes) {
    lines[i] = (lines[i] ?? "").replace(CHECKBOX, (_all, open: string, mark: string) => {
      if (mark !== " ") return `${open}${mark}]`;
      newly++;
      return `${open}x]`;
    });
  }
  return { kind: "ok", body: lines.join(""), total: boxes.length, newly };
}
