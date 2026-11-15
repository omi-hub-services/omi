// Pure part of `flow.ts review-comment` (OMI-077): the format `merge`, `close` and `status.ts`
// read from an agent review (omi-next step 5, ADR-0014), checked before it is posted.
//   **VERDICT:** PASS|FAIL · **REVIEWED_HEAD:** `<sha>`
//   AC-<n>: met|not met — <evidence>      (exactly one per top-level AC of the Issue)
import "../register-ts-imports.ts";
const { hasSecuritySection, parseAcReviewLines, reviewHeader } =
  await import("../../src/domain/delivery/acceptance-review.ts");
const { linkedIssueNumber } = await import("../../src/domain/delivery/pull-issue-link.ts");
const { implementationPaths } = await import("../../src/domain/tasks/implementation-map.ts");
const { workflowRisks } = await import("../../src/domain/workflows/workflow-policy.ts");

const { validRegressionEvidence } =
  await import("../../src/application/services/validate-review-evidence.ts");

export type ReviewCheck =
  | { readonly ok: true; readonly verdict: "PASS" | "FAIL"; readonly head: string }
  | { readonly ok: false; readonly reasons: readonly string[] };

const names = (ns: readonly number[]) => ns.map((n) => `AC-${String(n)}`).join(", ");

export function checkReview(
  body: string,
  ctx: {
    readonly acCount: number;
    readonly prHead: string;
    readonly workflow?: string | null | undefined;
    /** Merge base of the PR head and its base branch: where the regression evidence was recorded. */
    readonly forkPoint?: string | null | undefined;
    readonly regressionEvidence?: unknown;
    /** See `securityReviewRisk`; such a review needs its `Security:` section. */
    readonly securityRisk?: boolean | undefined;
  },
): ReviewCheck {
  const reasons: string[] = [];
  if (ctx.securityRisk === true && !hasSecuritySection(body))
    reasons.push("a security-relevant review needs a `Security:` section with its evidence");
  const header = reviewHeader(body, true);
  const m = header === undefined ? undefined : ["", header.verdict, header.head];
  if (!m?.[1] || !m[2]) {
    reasons.push("the review has no line `**VERDICT:** PASS|FAIL · **REVIEWED_HEAD:** `<sha>``");
  } else if (!ctx.prHead.startsWith(m[2])) {
    reasons.push(`REVIEWED_HEAD ${m[2]} is not the PR head ${ctx.prHead.slice(0, 7)}`);
  }

  if (ctx.acCount === 0) reasons.push("the Issue has no top-level acceptance criteria to review");
  const seen = new Map<number, "met" | "not met" | "deferred">();
  const repeated = new Set<number>();
  for (const line of parseAcReviewLines(body, ctx.workflow === "release")) {
    const n = line.number;
    if (line.verdict === undefined) {
      reasons.push(
        `AC-${String(n)} line needs "— <evidence>" after met/not met${ctx.workflow === "release" ? "/deferred" : ""}`,
      );
      continue;
    }
    if (seen.has(n)) repeated.add(n);
    seen.set(n, line.verdict);
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

  if (
    m?.[1] === "PASS" &&
    ctx.workflow === "bugfix" &&
    !validRegressionEvidence(ctx.regressionEvidence, ctx.forkPoint ?? "", ctx.prHead)
  ) {
    reasons.push(
      "bugfix needs script regression evidence red on the exact base and green on the exact head",
    );
  }

  if (reasons.length > 0 || !m?.[1] || !m[2]) return { ok: false, reasons };
  return { ok: true, verdict: m[1] === "PASS" ? "PASS" : "FAIL", head: m[2] };
}

/** The security risk the review packet was rendered with: Issue paths, Area, or `--risk security`. */
export function securityReviewRisk(
  issueBody: string,
  area: string | null,
  explicitRisk?: string,
): boolean {
  return (
    workflowRisks(implementationPaths(issueBody), area).security ||
    (explicitRisk?.split(",").includes("security") ?? false)
  );
}

/** Issue number of the `Issue: #N` line every PR body carries (AGENTS.md section 8). */
export function linkedIssue(prBody: string): number | null {
  return linkedIssueNumber(prBody) ?? null;
}
