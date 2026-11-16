// Text the Coordinator used to write by hand, derived from recorded data (OMI-185): the review
// verdict file, the commit message, the PR body, the close comment and the previous-review
// section of a later review packet. Pure: callers read the signed step reports, the diff and
// the check log and pass them in. Judging a finding or a criterion stays with the reviewer.
import {
  parseAcReviewLines,
  securitySectionLines,
} from "../../domain/delivery/acceptance-review.js";

export type Composed<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly reasons: readonly string[] };

const AC_LINE = /^\s*(?:[-*+]\s+)?AC-(\d+)\s*:/;
const names = (ns: readonly number[]) => ns.map((n) => `AC-${String(n)}`).join(", ");

/**
 * VERDICT file from the AC lines of a review step report: PASS only when the step succeeded and
 * every criterion is `met` (a release review may also `deferred` one). The report's `Security:`
 * section is kept. Refuses a missing, repeated, unknown or malformed line, so the file
 * is always one `review-comment` accepts.
 */
export function composeVerdict(input: {
  readonly acCount: number;
  readonly summary: string;
  readonly head: string;
  readonly status: "succeeded" | "failed" | "blocked";
  /** Only a `release` review may carry `AC-n: deferred` lines (as `review-comment` checks). */
  readonly workflow?: string | null | undefined;
}): Composed<{ readonly verdict: "PASS" | "FAIL"; readonly text: string }> {
  const reasons: string[] = [];
  const release = input.workflow === "release";
  const lines = parseAcReviewLines(input.summary, release);
  const seen = new Map<number, string | undefined>();
  const repeated = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.number)) repeated.add(line.number);
    seen.set(line.number, line.verdict);
    if (line.verdict === undefined)
      reasons.push(
        `AC-${String(line.number)} line needs "— <evidence>" after met/not met${release ? "/deferred" : ""}`,
      );
  }
  const numbers = Array.from({ length: input.acCount }, (_, i) => i + 1);
  const missing = numbers.filter((n) => !seen.has(n));
  const extra = [...seen.keys()].filter((n) => n < 1 || n > input.acCount);
  if (input.acCount === 0) reasons.push("the Issue has no top-level acceptance criteria");
  if (missing.length > 0)
    reasons.push(`no line for ${names(missing)} (the Issue has ${String(input.acCount)})`);
  if (extra.length > 0) reasons.push(`${names(extra)} does not exist`);
  if (repeated.size > 0) reasons.push(`${names([...repeated])} appears more than once`);
  if (reasons.length > 0) return { ok: false, reasons };
  const acLines = input.summary
    .split(/\r?\n/)
    .filter((line) => AC_LINE.test(line))
    .map((line) => line.trim().replace(/^[-*+]\s+/, ""))
    .sort((a, b) => Number(AC_LINE.exec(a)?.[1]) - Number(AC_LINE.exec(b)?.[1]));
  const allMet = numbers.every(
    (n) => seen.get(n) === "met" || (release && seen.get(n) === "deferred"),
  );
  const security = securitySectionLines(input.summary);
  while (security.length > 0 && security.at(-1)?.trim() === "") security.pop();
  const verdict = allMet && input.status === "succeeded" ? "PASS" : "FAIL";
  return {
    ok: true,
    verdict,
    text: `**VERDICT:** ${verdict} · **REVIEWED_HEAD:** \`${input.head}\`\n\n${acLines.join("\n")}\n${security.length > 0 ? `\n${security.join("\n")}\n` : ""}`,
  };
}

const PROPOSED_COMMIT =
  /^[ \t]*(?:[-*+][ \t]+)?\**Proposed commit(?: message)?\**[ \t]*:[ \t]*\**[ \t]*(\S.*?)[ \t]*$/im;

/** The worker's `Proposed commit: <subject>` line plus the configured attribution trailer. */
export function composeCommitMessage(
  summary: string,
  trailer: string,
): Composed<{ readonly message: string }> {
  const subject = PROPOSED_COMMIT.exec(summary)?.[1]
    ?.replace(/^`+|`+$/g, "")
    .trim();
  if (subject === undefined || subject === "" || subject.startsWith("ending "))
    return { ok: false, reasons: ['the report has no "Proposed commit: <message>" line'] };
  const body = subject.includes(trailer) ? subject : `${subject}\n\n${trailer}`;
  return { ok: true, message: `${body}\n` };
}

const TEST_KINDS = ["unit", "integration", "contract", "e2e", "live", "fixtures"];

/** Architecture folder map (§3) layer of a changed path. */
export function layerOf(path: string): string {
  const [top, second] = path.split("/");
  if (top === "src" && second !== undefined && path.split("/").length > 2) return second;
  if (top === "tests" && second !== undefined && TEST_KINDS.includes(second))
    return `tests (${second})`;
  if (top === "tools") return "coordinator tooling";
  if (top === "templates" || top === "docs" || top === "schemas") return top;
  return "root";
}

/** PR body: the `Issue: #N` link, files by layer, the check evidence and optional notes. */
export function composePrBody(input: {
  readonly issue: number;
  readonly files: readonly string[];
  readonly head: string;
  readonly check: { readonly command: string; readonly log: string };
  readonly notes?: string | undefined;
}): string {
  const rows = input.files.map((file) => `| \`${file}\` | ${layerOf(file)} |`);
  const notes = input.notes?.trim();
  return [
    `Issue: #${String(input.issue)}`,
    "",
    "## Files by layer",
    "",
    "| File | Layer |",
    "| --- | --- |",
    ...rows,
    "",
    "## Check evidence",
    "",
    `\`${input.check.command}\` passed on \`${input.head}\`:`,
    "",
    "```",
    input.check.log.trimEnd(),
    "```",
    ...(notes ? ["", "## Coordinator notes", "", notes] : []),
    "",
  ].join("\n");
}

/** Closing evidence comment: PR, merge commit, required checks and the review verdict line. */
export function composeCloseComment(input: {
  readonly issue: number;
  readonly pr: number;
  readonly mergeCommit: string | null;
  readonly requiredChecks: readonly string[];
  readonly verdict: { readonly verdict: string; readonly head: string };
}): string {
  return [
    `Closing #${String(input.issue)}.`,
    "",
    `- PR #${String(input.pr)}, merge commit \`${input.mergeCommit ?? "unknown"}\``,
    `- Required checks (enforced green at merge): ${input.requiredChecks.join(", ") || "none"}`,
    `- Review: **VERDICT:** ${input.verdict.verdict} · **REVIEWED_HEAD:** \`${input.verdict.head}\``,
    "",
  ].join("\n");
}

/** The earlier review of a later round, as the "Previous verdict" section of the packet. */
export function renderPreviousReview(input: {
  readonly round: number;
  readonly status: string;
  readonly head: string | null;
  readonly summary: string;
  readonly findings: readonly string[];
}): string {
  return [
    `Review round ${String(input.round)} (${input.status}) on head ${input.head ?? "unknown"}:`,
    input.summary,
    "Findings:",
    ...(input.findings.length === 0 ? ["none"] : input.findings),
  ].join("\n");
}
