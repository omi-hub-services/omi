// Wiring of the composed texts of OMI-185 (verdict file, commit message, PR body, close comment,
// previous review of a later round) to the signed step reports, git and the stored check. The
// composition itself is src/application/services/compose-delivery-text.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "../register-ts-imports.ts";
const {
  composeCloseComment,
  composeCommitMessage,
  composePrBody,
  composeVerdict,
  renderPreviousReview,
} = await import("../../src/application/services/compose-delivery-text.ts");
import { countAcceptanceCriteria } from "./acceptance-criteria.ts";
import { readStoredCheck, CHECK_ARGV } from "./check-reuse.ts";
import {
  BASE_BRANCH,
  COMMIT_TRAILER,
  COORDINATOR_LOGIN,
  type CoordinatorTarget,
} from "./coordinator-settings.ts";
import { latestAgentReview, linkedIssue } from "./github-snapshot.ts";
import { wslGit } from "./git-probe.ts";
import type { AuthoredComment } from "./json-shape.ts";
import { runChecked, type Runner } from "./process-runner.ts";
import { parseStepMarkers, parseStepResults } from "./worker-report.ts";
import type { ReferencingPull } from "./flow-plans.ts";

export interface RecordedReport {
  readonly step: string;
  readonly round: number;
  readonly status: "succeeded" | "failed" | "blocked";
  /** The head the Coordinator signed into the report header (dispatch metadata, never worker text). */
  readonly head: string | null;
  readonly summary: string;
  readonly findings: readonly string[];
}

/** Signed step reports of the Issue, oldest first, one entry per step id of a combined report. */
export function recordedReports(comments: readonly AuthoredComment[]): RecordedReport[] {
  return comments.flatMap((c) => {
    const [parsed] = parseStepMarkers([c], COORDINATOR_LOGIN);
    if (parsed === undefined) return [];
    const header = c.body.split("\n**Summary:**")[0] ?? "";
    const head = /^\*\*Status:\*\* \S+ · head `([0-9a-f]{40})`$/m.exec(header)?.[1] ?? null;
    return parseStepResults([c], COORDINATOR_LOGIN).map((r) => ({
      step: r.stepId,
      round: r.round,
      status: parsed.marker.status,
      head,
      summary: r.summary,
      findings: r.findings,
    }));
  });
}

/** Steps whose reports carry no proposed commit of the implementer. */
const NOT_WORK_STEPS = ["analyze", "architect", "verify", "review"];

/** VERDICT text from the newest signed review report; refuses unless it is on the PR head. */
export function verdictFromReports(input: {
  readonly comments: readonly AuthoredComment[];
  readonly issueBody: string;
  readonly prHead: string;
  /** The Issue's Workflow: only `release` accepts deferred criteria. */
  readonly workflow?: string | null | undefined;
}) {
  const report = recordedReports(input.comments)
    .filter((r) => r.step === "review")
    .at(-1);
  const refuse = (reason: string) => ({ ok: false as const, reasons: [reason] });
  if (report === undefined) return refuse("no signed review step report on the Issue");
  if (report.head === null) return refuse("the newest review report records no head");
  if (!input.prHead.startsWith(report.head))
    return refuse(
      `the newest review report is on ${report.head.slice(0, 7)}, not the PR head ${input.prHead.slice(0, 7)}`,
    );
  return composeVerdict({
    acCount: countAcceptanceCriteria(input.issueBody),
    summary: report.summary,
    head: report.head,
    status: report.status,
    workflow: input.workflow,
  });
}

/** Commit message from the newest implementer report's `Proposed commit` line plus the trailer. */
export function commitMessageFromReports(comments: readonly AuthoredComment[]) {
  const report = recordedReports(comments)
    .filter((r) => !NOT_WORK_STEPS.includes(r.step))
    .at(-1);
  if (report === undefined)
    return { ok: false as const, reasons: ["no signed worker report on the Issue"] };
  return composeCommitMessage(report.summary, COMMIT_TRAILER);
}

/** The newest review report before `round`, as the packet's previous verdict, with its head. */
export function previousReviewOf(comments: readonly AuthoredComment[], round: number) {
  const report = recordedReports(comments)
    .filter((r) => r.step === "review" && r.round < round)
    .at(-1);
  return report === undefined ? null : { head: report.head, text: renderPreviousReview(report) };
}

/** PR body from the diff against the base, the stored check of the branch head and the notes. */
export async function generatedPrBody(
  run: Runner,
  target: CoordinatorTarget,
  input: { issue: number; branch: string; notes?: string | undefined },
): Promise<string> {
  const git = wslGit(target);
  const head = (await runChecked(run, git(["rev-parse", input.branch]))).trim();
  const files = (
    await runChecked(run, git(["diff", "--name-only", `origin/${BASE_BRANCH}...${input.branch}`]))
  )
    .split("\n")
    .filter((f) => f.trim() !== "");
  const stored = await readStoredCheck(run, target, head);
  if (stored?.status !== "passed")
    throw new Error(
      `no passed check result stored for ${head}; run flow.ts check ${input.branch} --head ${head} or pass --body-file`,
    );
  return composePrBody({
    issue: input.issue,
    files,
    head,
    check: { command: CHECK_ARGV.join(" "), log: stored.log },
    notes: input.notes,
  });
}

export function writePrBody(cwd: string, issue: number, body: string): string {
  const dir = join(cwd, ".tmp");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pr-body-${String(issue)}.md`);
  writeFileSync(file, body, "utf8");
  return file;
}

/** Close comment for the merged PR that ticking would use (latest merged task PR of the Issue). */
export async function generatedCloseComment(input: {
  readonly issue: number;
  readonly workflow: string | null;
  readonly pulls: readonly ReferencingPull[];
  readonly mergeCommitOf: (pr: number) => Promise<string | null>;
  readonly requiredChecksOf: (base: string) => Promise<readonly string[]>;
}): Promise<string> {
  const bases = input.workflow === "release" ? [BASE_BRANCH, "main"] : [BASE_BRANCH];
  const pr = input.pulls
    .filter((p) => p.merged && bases.includes(p.baseRefName) && linkedIssue(p.body) === input.issue)
    .sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? ""))
    .at(-1);
  if (pr === undefined)
    throw new Error(
      `no merged PR into ${bases.join(" or ")} has the line "Issue: #${String(input.issue)}"`,
    );
  const review = latestAgentReview(pr.comments);
  if (review === null) throw new Error(`PR #${String(pr.number)} has no agent review verdict`);
  return composeCloseComment({
    issue: input.issue,
    pr: pr.number,
    mergeCommit: await input.mergeCommitOf(pr.number),
    requiredChecks: await input.requiredChecksOf(pr.baseRefName),
    verdict: { verdict: review.verdict, head: review.head },
  });
}
