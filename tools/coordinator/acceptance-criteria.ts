// Acceptance criteria of an Issue body and the independent reviewer's verdict lines
// (omi-next step 5), one per criterion:
//   AC-<n>: met|not met — <evidence>
// numbered by the order of the checkboxes under the body's `## Acceptance criteria` heading
// (up to the next `#`/`##` heading). Ticking changes only `[ ]` to `[x]` on those lines; every
// other byte of the body stays as it was.

const HEADING = /^##\s+Acceptance criteria\s*$/i;
const SECTION_END = /^#{1,2}\s/;
const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])\]/;
const AC_LINE = /^\s*(?:[-*+]\s+)?AC-(\d+):\s*(met|not met)\b/;

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

/** Ticks every criterion when the review has a `met` line for each and nothing else. */
export function tickAcceptanceCriteria(
  body: string,
  verdicts: ReadonlyMap<number, AcVerdict>,
): TickResult {
  const refuse = (reason: string): TickResult => ({ kind: "refuse", reason });
  const lines = body.split(/(?<=\n)/);
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start === -1) return refuse('the Issue body has no "## Acceptance criteria" section');
  const boxes: number[] = [];
  for (let i = start + 1; i < lines.length && !SECTION_END.test(lines[i] ?? ""); i++) {
    if (CHECKBOX.test(lines[i] ?? "")) boxes.push(i);
  }
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
