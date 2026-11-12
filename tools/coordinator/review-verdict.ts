// Pure part of `flow.ts review-comment` (OMI-077): the format `merge`, `close` and `status.ts`
// read from an agent review (omi-next step 5, ADR-0014), checked before it is posted.
//   **VERDICT:** PASS|FAIL · **REVIEWED_HEAD:** `<sha>`
//   AC-<n>: met|not met — <evidence>      (exactly one per top-level AC of the Issue)
import { acLines } from "./acceptance-criteria.ts";

const VERDICT_LINE = /^\*\*VERDICT:\*\* (PASS|FAIL) · \*\*REVIEWED_HEAD:\*\* `([0-9a-f]{7,40})`/m;
const AC_STRICT = /^\s*(?:[-*+]\s+)?AC-(\d+):\s*(met|not met)\s+—\s+\S/;
const AC_NUMBER = /AC-(\d+)/;

export type ReviewCheck =
  | { readonly ok: true; readonly verdict: "PASS" | "FAIL"; readonly head: string }
  | { readonly ok: false; readonly reasons: readonly string[] };

const names = (ns: readonly number[]) => ns.map((n) => `AC-${String(n)}`).join(", ");

export function checkReview(
  body: string,
  ctx: { readonly acCount: number; readonly prHead: string },
): ReviewCheck {
  const reasons: string[] = [];
  const m = VERDICT_LINE.exec(body);
  if (!m?.[1] || !m[2]) {
    reasons.push("the review has no line `**VERDICT:** PASS|FAIL · **REVIEWED_HEAD:** `<sha>``");
  } else if (!ctx.prHead.startsWith(m[2])) {
    reasons.push(`REVIEWED_HEAD ${m[2]} is not the PR head ${ctx.prHead.slice(0, 7)}`);
  }

  if (ctx.acCount === 0) reasons.push("the Issue has no top-level acceptance criteria to review");
  const seen = new Map<number, "met" | "not met">();
  const repeated = new Set<number>();
  for (const line of acLines(body)) {
    const strict = AC_STRICT.exec(line);
    const n = Number(AC_NUMBER.exec(line)?.[1]);
    if (!strict?.[2]) {
      reasons.push(`AC-${String(n)} line needs "— <evidence>" after met/not met`);
      continue;
    }
    if (seen.has(n)) repeated.add(n);
    seen.set(n, strict[2] === "met" ? "met" : "not met");
  }
  const numbers = Array.from({ length: ctx.acCount }, (_, i) => i + 1);
  const missing = numbers.filter(
    (n) => !seen.has(n) && !reasons.some((r) => r.startsWith(`AC-${String(n)} `)),
  );
  const extra = [...seen.keys()].filter((n) => n < 1 || n > ctx.acCount);
  if (missing.length > 0)
    reasons.push(`no line for ${names(missing)} (the Issue has ${String(ctx.acCount)})`);
  if (extra.length > 0)
    reasons.push(`${names(extra)} does not exist (the Issue has ${String(ctx.acCount)})`);
  if (repeated.size > 0) reasons.push(`${names([...repeated])} appears more than once`);
  const notMet = [...seen].filter(([, v]) => v === "not met").map(([n]) => n);
  if (m?.[1] === "PASS" && notMet.length > 0) {
    reasons.push(`PASS needs every criterion met, but ${names(notMet)} is not met`);
  }

  if (reasons.length > 0 || !m?.[1] || !m[2]) return { ok: false, reasons };
  return { ok: true, verdict: m[1] === "PASS" ? "PASS" : "FAIL", head: m[2] };
}

/** Issue number of the `Issue: #N` line every PR body carries (AGENTS.md section 8). */
export function linkedIssue(prBody: string): number | null {
  const m = /^Issue:\s*#(\d+)\s*$/m.exec(prBody);
  return m?.[1] ? Number(m[1]) : null;
}
