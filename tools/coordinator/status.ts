// Coordinator status (ADR-0014): Project items by Status, Ready tasks whose blockers are all
// closed, open PRs with checks/review, and WSL workers. Deterministic; no LLM.
//   node tools/coordinator/status.ts [--json]
// gh calls: one GraphQL query (plus one per extra 100 Project items) and one REST read of the
// required checks; one wsl.exe call for workers, which degrades to "unavailable" on failure.
import { parseArgs } from "node:util";
import {
  OWNER,
  PROJECT_NUMBER,
  QUOTA_SETTINGS,
  REPO,
  WORKER_PROFILES,
  wslTarget,
} from "./coordinator-settings.ts";
import { graphql, readRequiredChecks } from "./github-reads.ts";
import {
  classifyReview,
  findMismatches,
  groupByStatus,
  ignoredVerdictWarnings,
  issueReadinessWarnings,
  linkedIssue,
  parseSnapshotPage,
  partitionReady,
  SNAPSHOT_QUERY,
  summarizeChecks,
  type OpenPull,
  type ProjectItem,
  type ReadyTask,
} from "./github-snapshot.ts";
import { createProcessRunner, type Runner } from "./process-runner.ts";
import { formatQuotaSection, readQuota, type QuotaReport } from "./quota.ts";
import { readWorkers, type Workers } from "./wsl-workers.ts";

const ACTIVE = new Set([
  "In Progress",
  "In Review",
  "Waiting Approval",
  "Waiting Resource",
  "Blocked",
]);

async function readProject(run: Runner) {
  const items: ProjectItem[] = [];
  let pulls: readonly OpenPull[] = [];
  let title: string;
  let after: string | null = null;
  do {
    const page = parseSnapshotPage(
      await graphql(run, SNAPSHOT_QUERY, {
        owner: OWNER,
        repo: REPO,
        project: PROJECT_NUMBER,
        after,
        withPulls: after === null,
      }),
    );
    title = page.projectTitle;
    items.push(...page.items);
    if (page.pulls) pulls = page.pulls;
    after = page.nextCursor;
  } while (after !== null);
  return { title, items, pulls };
}

const bare = (title: string) => title.replace(/^\[[A-Z]+-\d+\]\s*/, "");
const ref = (i: ProjectItem) =>
  `#${String(i.number ?? "-")} ${i.planKey ?? ""}`.trimEnd() + ` ${bare(i.title)}`;

const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function duration(seconds: number): string {
  if (seconds < 120) return `${String(seconds)}s`;
  if (seconds < 7200) return `${String(Math.round(seconds / 60))}m`;
  return `${String(Math.round(seconds / 3600))}h`;
}

function pullView(p: OpenPull, required: readonly string[]) {
  const checks = summarizeChecks(p.checks, required);
  const review = classifyReview(p);
  return {
    number: p.number,
    title: p.title,
    branch: p.headRefName,
    base: p.baseRefName,
    head: p.headRefOid,
    draft: p.isDraft,
    mergeState: p.mergeStateStatus,
    issue: linkedIssue(p.body),
    checks,
    review,
  };
}

function readyView(r: ReadyTask) {
  return {
    number: r.item.number,
    planKey: r.item.planKey,
    title: r.item.title,
    priority: r.item.priority,
    milestone: r.item.milestone,
    openBlockers: r.openBlockers,
    blockersTruncated: r.item.blockersTruncated,
  };
}

function renderText(report: ReturnType<typeof buildReport>): string {
  const out: string[] = [];
  out.push(`${report.project} — ${report.generatedAt}`);
  out.push(
    `Status: ${report.groups.map((g) => `${g.status} ${String(g.items.length)}`).join(" · ")}`,
  );
  for (const g of report.groups) {
    if (!ACTIVE.has(g.status) || g.items.length === 0) continue;
    out.push(`${g.status}:`);
    for (const i of g.items) out.push(`  ${short(ref(i))} ${i.priority ?? ""}`.trimEnd());
  }
  out.push("Ready, all blockers closed (priority order):");
  if (report.ready.length === 0) out.push("  (none)");
  for (const r of report.ready) {
    out.push(
      `  #${String(r.number)} ${r.planKey ?? ""} ${r.priority ?? "-"} ${r.milestone?.split(" ")[0] ?? "-"} ${short(bare(r.title), 60)}`,
    );
  }
  if (report.readyBlocked.length > 0) {
    out.push("Ready but blocked:");
    for (const r of report.readyBlocked) {
      const by = r.openBlockers.map((n) => `#${String(n)}`).join(", ");
      out.push(`  #${String(r.number)} ${r.planKey ?? ""} blocked by ${by || "(more than 20)"}`);
    }
  }
  out.push(`Open PRs (required checks: ${report.requiredChecks.join(", ") || "none"}):`);
  if (report.pulls.length === 0) out.push("  (none)");
  for (const p of report.pulls) {
    const agent = p.review.agent
      ? `agent ${p.review.agent.verdict}${p.review.agent.current ? " @head" : ` @${p.review.agent.head.slice(0, 7)} (stale)`}`
      : "no agent review";
    const checkDetail = [...p.checks.failing, ...p.checks.pending.map((n) => `${n}…`)].join(",");
    out.push(
      `  #${String(p.number)} ${p.branch} -> ${p.base} @${p.head.slice(0, 7)}${p.draft ? " draft" : ""}` +
        ` | checks ${p.checks.overall}${checkDetail ? ` (${checkDetail})` : ""}` +
        ` | review ${p.review.native ?? "-"}, ${agent}` +
        ` | Issue ${p.issue === null ? "MISSING" : `#${String(p.issue)}`} | ${p.mergeState}`,
    );
  }
  if (report.mismatches.length > 0) {
    out.push("Attention:");
    for (const m of report.mismatches) out.push(`  ${m}`);
  }
  const w = report.workers;
  if (!w.available) out.push(`WSL workers: unavailable (${short(w.reason, 120)})`);
  else {
    out.push(`WSL workers: ${String(w.processes.length)} running`);
    for (const p of w.processes) {
      out.push(
        `  pid ${String(p.pid)} ${p.tool} ${p.headless ? "headless" : "interactive"} ${duration(p.elapsedSeconds)}`,
      );
    }
    const log = w.latestLog;
    if (!log) out.push("  latest log: none in ~/omi-runs");
    else {
      const state = log.finished
        ? `finished${log.isError ? " with error" : ""}${log.numTurns === null ? "" : `, ${String(log.numTurns)} turns`}`
        : `last event ${log.lastEvent ?? "unreadable"}`;
      out.push(
        `  latest log: ${log.file} ${String(Math.round(log.sizeBytes / 1024))} KB, updated ${duration(log.ageSeconds)} ago, ${state}` +
          (log.sessionId ? `, session ${log.sessionId}` : ""),
      );
    }
  }
  out.push(...formatQuotaSection(report.quota));
  return out.join("\n");
}

function buildReport(
  project: Awaited<ReturnType<typeof readProject>>,
  required: readonly string[],
  workers: Workers,
  quota: QuotaReport,
) {
  const { unblocked, blocked } = partitionReady(project.items);
  const pulls = project.pulls.map((p) => pullView(p, required));
  return {
    generatedAt: new Date().toISOString(),
    project: project.title,
    groups: groupByStatus(project.items),
    ready: unblocked.map(readyView),
    readyBlocked: blocked.map(readyView),
    requiredChecks: required,
    pulls,
    mismatches: [
      ...findMismatches(project.items),
      ...issueReadinessWarnings(project.items),
      ...ignoredVerdictWarnings(pulls),
    ],
    workers,
    quota,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });
  const run = createProcessRunner();
  const [project, required, workers, quota] = await Promise.all([
    readProject(run),
    readRequiredChecks(run),
    readWorkers(run, wslTarget()),
    readQuota(run, wslTarget(), WORKER_PROFILES, QUOTA_SETTINGS, false),
  ]);
  const report = buildReport(project, required, workers, quota);
  if (values.json) {
    const groups = report.groups.map((g) => ({
      status: g.status,
      count: g.items.length,
      items: g.items.map((i) => ({
        number: i.number,
        planKey: i.planKey,
        title: i.title,
        priority: i.priority,
      })),
    }));
    console.log(JSON.stringify({ ...report, groups }, null, 2));
  } else console.log(renderText(report));
}

try {
  await main();
} catch (error) {
  console.error(`status: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
