// Coordinator status (ADR-0014): Project items by Status, Ready tasks whose blockers are all
// closed, open PRs with checks/review, and WSL workers. Deterministic; no LLM.
//   node tools/coordinator/status.ts [--json]
// Reads Project/README, required checks and next steps; one WSL call each for workers and
// local Git state. Local sources degrade independently to "unavailable" on failure.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { COORDINATOR_TOOL_ROOT } from "./tool-root.ts";
import { QUOTA_SETTINGS, coordinatorProfiles, coordinatorTarget } from "./coordinator-settings.ts";
import { readProject, readProjectReadme, readRequiredChecks } from "./github-reads.ts";
import {
  classifyReview,
  findMismatches,
  formatAgentReview,
  groupByStatus,
  ignoredVerdictWarnings,
  issueReadinessWarnings,
  linkedIssue,
  partitionReady,
  summarizeChecks,
  type OpenPull,
  type ProjectItem,
  type ReadyTask,
} from "./github-snapshot.ts";
import { createProcessRunner, type Runner } from "./process-runner.ts";
import { promotableBacklog } from "./promote.ts";
import { formatQuotaSection, readQuota, type QuotaReport } from "./quota.ts";
import { readLocalState, readWorkers, type Workers } from "./wsl-workers.ts";

export function handoffView(text: string, now: Date) {
  const stamp = /^Updated: (\S+) · develop:/m.exec(text)?.[1];
  const updatedAt = stamp !== undefined && Number.isFinite(Date.parse(stamp)) ? stamp : null;
  return {
    text,
    updatedAt,
    ageSeconds:
      updatedAt === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - Date.parse(updatedAt)) / 1000)),
  };
}

export async function readNextLines(
  run: Runner,
  items: readonly Pick<ProjectItem, "kind" | "number" | "status">[],
  hostCwd: string,
) {
  return Promise.all(
    items
      .filter(
        (i) =>
          i.kind === "Issue" &&
          i.number !== null &&
          ["In Progress", "In Review"].includes(i.status ?? ""),
      )
      .map(async (i) => {
        try {
          const result = await run({
            file: process.execPath,
            args: [
              join(COORDINATOR_TOOL_ROOT, "tools/coordinator/flow.ts"),
              "next",
              String(i.number),
            ],
            cwd: hostCwd,
            timeoutMs: 30_000,
          });
          return {
            number: i.number,
            result:
              (result.code === 0 ? result.stdout : result.stderr || result.stdout)
                .trim()
                .split(/\r?\n/)[0] || "next: unavailable",
          };
        } catch (error) {
          return {
            number: i.number,
            result: `next: unavailable (${error instanceof Error ? error.message : String(error)})`,
          };
        }
      }),
  );
}

const ACTIVE = new Set([
  "In Progress",
  "In Review",
  "Waiting Approval",
  "Waiting Resource",
  "Blocked",
]);

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

export function renderText(report: ReturnType<typeof buildReport>): string {
  const out: string[] = [];
  const handoff = report.handoff;
  out.push(
    `Coordinator handoff (${handoff.ageSeconds === null ? "age unknown" : `${duration(handoff.ageSeconds)} ago`}):`,
  );
  out.push(handoff.text || "  (empty)");
  out.push(`${report.project} — ${report.generatedAt}`);
  out.push(
    `Status: ${report.groups.map((g) => `${g.status} ${String(g.items.length)}`).join(" · ")}`,
  );
  for (const g of report.groups) {
    if (!ACTIVE.has(g.status) || g.items.length === 0) continue;
    out.push(`${g.status}:`);
    for (const i of g.items) out.push(`  ${short(ref(i))} ${i.priority ?? ""}`.trimEnd());
  }
  for (const n of report.next) out.push(`  #${String(n.number)} ${n.result}`);
  out.push("Local state:");
  const local = report.localState;
  if (!local.wsl.available) out.push(`  WSL: unavailable (${local.wsl.reason})`);
  else {
    out.push("  WSL worktrees (~/github/omi-wt/):");
    if (!local.wsl.worktrees.length) out.push("    (none)");
    for (const w of local.wsl.worktrees)
      out.push(`    ${w.path} ${w.branch} ${w.dirty ? "dirty" : "clean"}`);
    out.push(`  Unpushed task branches: ${local.wsl.unpushedBranches.join(", ") || "(none)"}`);
  }
  out.push(
    local.host.available
      ? `  Modified tracked host files: ${local.host.modifiedTrackedFiles.join(", ") || "(none)"}`
      : `  Host: unavailable (${local.host.reason})`,
  );
  out.push(
    local.pin.available
      ? `  Pin: ${local.pin.sha ?? "uninitialized"} vs origin/develop ${local.pin.developSha} (${local.pin.matchesDevelop ? "matches" : "differs"}; initialized: ${String(local.pin.initialized)})${local.pin.reason ? ` — ${local.pin.reason}` : ""}`
      : `  Pin: unavailable (${local.pin.reason})`,
  );
  out.push("Backlog, all blockers closed (priority order, ready to promote):");
  if (report.backlog.length === 0) out.push("  (none)");
  for (const r of report.backlog) {
    out.push(
      `  #${String(r.number)} ${r.planKey ?? ""} ${r.priority ?? "-"} ${r.milestone?.split(" ")[0] ?? "-"} ${short(bare(r.title), 60)}`,
    );
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
    const agent = formatAgentReview(p.review.agent);
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
  handoff: ReturnType<typeof handoffView>,
  localState: Awaited<ReturnType<typeof readLocalState>>,
  next: Awaited<ReturnType<typeof readNextLines>>,
) {
  const { unblocked, blocked } = partitionReady(project.items);
  const pulls = project.pulls.map((p) => pullView(p, required));
  return {
    handoff,
    localState,
    next,
    generatedAt: new Date().toISOString(),
    project: project.title,
    groups: groupByStatus(project.items),
    ready: unblocked.map(readyView),
    readyBlocked: blocked.map(readyView),
    backlog: promotableBacklog(project.items).map(readyView),
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

export function renderJson(report: ReturnType<typeof buildReport>): string {
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
  return JSON.stringify({ ...report, groups }, null, 2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });
  const run = createProcessRunner();
  const [project, required, workers, quota, readme, localState] = await Promise.all([
    readProject(run),
    readRequiredChecks(run),
    readWorkers(run, await coordinatorTarget()),
    readQuota(run, await coordinatorTarget(), await coordinatorProfiles(), QUOTA_SETTINGS, false),
    readProjectReadme(run),
    readLocalState(run, await coordinatorTarget(), process.cwd()),
  ]);
  const next = await readNextLines(run, project.items, process.cwd());
  const report = buildReport(
    project,
    required,
    workers,
    quota,
    handoffView(readme.text, new Date()),
    localState,
    next,
  );
  if (values.json) {
    console.log(renderJson(report));
  } else console.log(renderText(report));
}

if (import.meta.main)
  try {
    await main();
  } catch (error) {
    console.error(`status: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
