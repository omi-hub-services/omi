// Mechanical steps of /omi-next (ADR-0014). Run by the Coordinator on Windows; git steps go to
// the WSL checkout through wsl.exe (inside Linux they run in bash directly).
//   node tools/coordinator/flow.ts <subcommand> ... [--dry-run]
// Every subcommand reads the current state first: an already-done step prints "done:" and exits
// 0, an unsafe one prints "refused:" and exits 1, otherwise it runs (or with --dry-run prints)
// the argv it needs. Auth comes from the local gh/git logins; nothing token-like is printed.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createIssue } from "./issue-creation.ts";
import { issueReadinessReasons, type IssueReadiness } from "./issue-readiness.ts";
import { countAcceptanceCriteria } from "./acceptance-criteria.ts";
import { inferComplexity, type EffortInput } from "./effort-policy.ts";
import {
  BASE_BRANCH,
  EFFORT_POLICY,
  OWNER,
  PROJECT_NUMBER,
  QUOTA_SETTINGS,
  REPO,
  REPO_SLUG,
  RUNS_RETENTION,
  WORKER_PROFILES,
  wslTarget,
  type WslTarget,
} from "./coordinator-settings.ts";
import {
  assertSha,
  assertTaskBranch,
  planCheck,
  planCleanup,
  planClose,
  planMerge,
  planOpenPr,
  planPush,
  planSetStatus,
  planStartBranch,
  taskBranchName,
  toCommands,
  type ExistingPull,
  type IssueItem,
  type Plan,
  type PullForMerge,
  type ReferencingPull,
  type StatusField,
  type Step,
} from "./flow-plans.ts";
import { localGit, probeBranch, probeCleanupWsl, wslGit, type ProbeOptions } from "./git-probe.ts";
import { graphql, readProject, readRequiredChecks } from "./github-reads.ts";
import {
  agentReviewOn,
  latestAgentReview,
  parsePull,
  PULL_FIELDS,
  type Blocker,
} from "./github-snapshot.ts";
import {
  carriedComment,
  conflictRefusal,
  decideSync,
  judgeCarriedHead,
  parseMergeTree,
  type CarryJudgement,
} from "./carried-pass.ts";
import { judgeCarryChain, readCarryFacts } from "./carry-git.ts";
import { judgePromotion, promotableBacklog } from "./promote.ts";
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  authoredComments,
  type AuthoredComment,
  commentBodies,
  nodes,
  optObject,
  optString,
  parseJson,
} from "./json-shape.ts";
import {
  createProcessRunner,
  formatCommand,
  runChecked,
  wslCommand,
  type Runner,
} from "./process-runner.ts";
import {
  parseRunsListing,
  planRetention,
  retentionScript,
  RUNS_LISTING,
} from "./runs-retention.ts";
import { formatPick, pickProfile, readQuota, WORKER_KINDS, type WorkerKind } from "./quota.ts";
import {
  commitWorkerCommand,
  dispatchCommand,
  reviewCommentCommand,
  workerReportCommand,
} from "./flow-workers.ts";
import { linkedIssue } from "./review-verdict.ts";
import { promptCommand } from "./flow-prompt.ts";

const USAGE = `usage: node tools/coordinator/flow.ts <subcommand> [--dry-run]
  new-issue --file <spec.md>                 validated Issue with Project fields and Backlog
  set-status <issue> <status>
  promote [<issue>]                           Backlog -> Ready if blockers closed and ready (no N: first by priority)
  start-branch <issue> <slug>                 WSL: task/omi-NNN-<slug> from origin/${BASE_BRANCH}
  push <branch>                               WSL: git push -u origin <branch>
  check <branch> --head <sha>                 WSL: npm run check on exactly <sha>
  open-pr <issue> <branch> --title <t> --body-file <f>
  sync <branch> --reviewed <sha>              WSL: merge origin/${BASE_BRANCH}, check, push, carry the PASS
                                              (clean merges only; a conflict is aborted and refused)
  merge <pr> --head <sha>                     checks green, agent PASS @head, merge state clean
  close <issue> --comment-file <f>            tick AC from the review + comment + close + Done
  cleanup <branch>                            delete the merged local branch (WSL and host), then
                                              archive its worker logs in ~/omi-runs
  prune-runs                                  one-time log sweep for every Done task
  pick-profile <issue> [--kind claude|codex|claude+codex-live] [--probe] [--model NAME] [--json]
                                              worker profile by quota (--probe: 1 Haiku call/profile)
  prompt <issue> --step <id> [--worktree <dir>] [--branch <b>] [--notes <f> | --findings <f>] [--out <f>]
                                              render the workflow step packet; --dry-run previews without writing
  dispatch <issue> --profile <p> [--kind claude|codex] [--resume <id>] --prompt <file>
                                              WSL: unchanged prompt to ~/omi-runs, then the worker
                                              in the foreground (model/effort from the effort policy)
  worker-report <issue>                       final report, turns, permission denials, session/thread id
  commit-worker <branch> --message-file <f>   WSL: stage src tests docs templates schemas, commit, print SHA
  review-comment <pr> --file <f>              check VERDICT/REVIEWED_HEAD/AC-n lines, post as the Coordinator`;

export interface Context {
  readonly run: Runner;
  readonly target: WslTarget;
  readonly hostCwd: string;
  readonly isWindows: boolean;
}

// ── GitHub reads ─────────────────────────────────────────────────────────────
const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $project: Int!) {
  organization(login: $owner) { projectV2(number: $project) { id
    field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } }
  repository(owner: $owner, name: $repo) { issue(number: $number) { state body
    blockedBy(first: 20) { totalCount nodes { number state } }
    labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
    comments(last: 100) { nodes { body } }
    timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 30) { nodes {
      ... on CrossReferencedEvent { source { ... on PullRequest {
        number merged mergedAt baseRefName headRefOid body repository { nameWithOwner }
        comments(last: 50) { nodes { author { login } body } } } } } } }
    projectItems(first: 20) { nodes { id project { id }
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      workflow: fieldValueByName(name: "Workflow") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      workType: fieldValueByName(name: "Work Type") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      role: fieldValueByName(name: "Role") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      area: fieldValueByName(name: "Area") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      complexity: fieldValueByName(name: "complexity") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      planKey: fieldValueByName(name: "Plan Key") { ... on ProjectV2ItemFieldTextValue { text } }
    } } } }
}`;

interface IssueContext {
  readonly effortInput: EffortInput;
  readonly readiness: IssueReadiness;
  readonly field: StatusField;
  readonly item: IssueItem | null;
  readonly planKey: string | null;
  readonly state: string;
  readonly body: string;
  readonly blockers: readonly Blocker[];
  readonly blockersTruncated: boolean;
  readonly comments: readonly string[];
  readonly pulls: readonly ReferencingPull[];
}

/**
 * PRs of this repository among the Issue's cross-references (an Issue source parses to an empty
 * object). A PR in another repository can mention the Issue too, but is never evidence for it.
 */
export function referencingPulls(issue: Readonly<Record<string, unknown>>): ReferencingPull[] {
  return nodes(issue, "timelineItems", "issue").flatMap((raw) => {
    const pr = optObject(asObject(raw, "event").source, "event.source");
    if (pr?.number === undefined) return [];
    const repo = asObject(pr.repository, "source.repository");
    if (asString(repo.nameWithOwner, "source.repository.nameWithOwner") !== REPO_SLUG) return [];
    return [
      {
        number: asNumber(pr.number, "source.number"),
        merged: asBoolean(pr.merged, "source.merged"),
        mergedAt: optString(pr.mergedAt, "source.mergedAt"),
        baseRefName: asString(pr.baseRefName, "source.baseRefName"),
        headRefOid: asString(pr.headRefOid, "source.headRefOid"),
        body: asString(pr.body, "source.body"),
        comments: authoredComments(pr, "source"),
      },
    ];
  });
}

async function readIssue(ctx: Context, number: number): Promise<IssueContext> {
  const data = await graphql(ctx.run, ISSUE_QUERY, {
    owner: OWNER,
    repo: REPO,
    number,
    project: PROJECT_NUMBER,
  });
  const project = asObject(asObject(data.organization, "organization").projectV2, "projectV2");
  const projectId = asString(project.id, "projectV2.id");
  const field = asObject(project.field, "Status field");
  const issue = optObject(asObject(data.repository, "repository").issue, "issue");
  if (!issue) throw new Error(`Issue #${String(number)} not found in ${REPO_SLUG}`);
  const item = nodes(issue, "projectItems", "issue")
    .map((n) => asObject(n, "projectItem"))
    .find((n) => asObject(n.project, "project").id === projectId);
  const labels = asObject(issue.labels, "issue.labels");
  if (asBoolean(asObject(labels.pageInfo, "labels.pageInfo").hasNextPage, "labels.hasNextPage")) {
    throw new Error("Issue labels truncated; cannot determine complexity override");
  }
  const blockedBy = optObject(issue.blockedBy, "issue.blockedBy");
  const blockers = (blockedBy ? asArray(blockedBy.nodes, "blockedBy.nodes") : []).map((raw) => {
    const b = asObject(raw, "blocker");
    return {
      number: asNumber(b.number, "blocker.number"),
      state: asString(b.state, "blocker.state"),
    };
  });
  const select = (name: string) => optString(optObject(item?.[name], name)?.name, `${name}.name`);
  const complexity = select("complexity");
  if (
    complexity !== null &&
    complexity !== "low" &&
    complexity !== "medium" &&
    complexity !== "high"
  ) {
    throw new Error("Invalid Project complexity field");
  }
  return {
    readiness: {
      planKey: item ? optString(optObject(item.planKey, "planKey")?.text, "planKey.text") : null,
      body: asString(issue.body, "issue.body"),
      priority: select("priority"),
      workType: select("workType"),
      workflow: select("workflow"),
      role: select("role"),
      area: select("area"),
    },
    effortInput: {
      ...(complexity === null ? {} : { complexity }),
      workflow: select("workflow"),
      workType: select("workType"),
      area: select("area"),
      priority: select("priority"),
      acCount: countAcceptanceCriteria(asString(issue.body, "issue.body")),
      labels: nodes(issue, "labels", "issue").map((raw) =>
        asString(asObject(raw, "label").name, "label.name"),
      ),
    },
    field: {
      projectId,
      fieldId: asString(field.id, "Status field id"),
      options: asArray(field.options, "Status options").map((o) => {
        const opt = asObject(o, "option");
        return { id: asString(opt.id, "option.id"), name: asString(opt.name, "option.name") };
      }),
    },
    item: item
      ? {
          itemId: asString(item.id, "item.id"),
          status: optString(optObject(item.status, "status")?.name, "status.name"),
        }
      : null,
    planKey: item ? optString(optObject(item.planKey, "planKey")?.text, "planKey.text") : null,
    state: asString(issue.state, "issue.state"),
    body: asString(issue.body, "issue.body"),
    blockers,
    blockersTruncated: blockedBy
      ? asNumber(blockedBy.totalCount, "blockedBy.totalCount") > blockers.length
      : false,
    comments: commentBodies(issue, "issue"),
    pulls: referencingPulls(issue),
  };
}

const PULL_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    state mergeCommit { oid } ${PULL_FIELDS}
  } }
}`;

async function readPull(ctx: Context, number: number): Promise<PullForMerge> {
  const data = await graphql(ctx.run, PULL_QUERY, { owner: OWNER, repo: REPO, number });
  const pr = optObject(asObject(data.repository, "repository").pullRequest, "pullRequest");
  if (!pr) throw new Error(`PR #${String(number)} not found in ${REPO_SLUG}`);
  return {
    ...parsePull(pr, "pullRequest"),
    state: asString(pr.state, "pr.state"),
    mergeCommit: optString(optObject(pr.mergeCommit, "mergeCommit")?.oid, "mergeCommit.oid"),
  };
}

async function readExistingPulls(ctx: Context, branch: string): Promise<ExistingPull[]> {
  const stdout = await runChecked(ctx.run, {
    file: "gh",
    args: [
      "pr",
      "list",
      "-R",
      REPO_SLUG,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,url,baseRefName",
    ],
  });
  return asArray(parseJson(stdout, "gh pr list"), "prs").map((raw) => {
    const p = asObject(raw, "pr");
    return {
      number: asNumber(p.number, "pr.number"),
      state: asString(p.state, "pr.state"),
      url: asString(p.url, "pr.url"),
      baseRefName: asString(p.baseRefName, "pr.baseRefName"),
    };
  });
}

// ── git state ────────────────────────────────────────────────────────────────
const probeWsl = (ctx: Context, branch: string, options?: ProbeOptions) =>
  probeBranch(ctx.run, wslGit(ctx.target), branch, options);

/**
 * The Windows checkout (cwd) when it is a clone of this repository (the Coordinator fetches task
 * branches into it from WSL, so they need cleaning up there too); Linux has none.
 */
async function probeHost(ctx: Context, branch: string, options: ProbeOptions) {
  if (!ctx.isWindows) return null;
  const git = localGit(ctx.hostCwd);
  const origin = await ctx.run(git(["remote", "get-url", "origin"]));
  if (origin.code !== 0 || !origin.stdout.includes(REPO_SLUG)) return null;
  return probeBranch(ctx.run, git, branch, options);
}

/** Dry-run changes nothing, not even remote-tracking refs: no fetch, "merged" is as of now. */
export async function cleanup(ctx: Context, branch: string, dryRun: boolean): Promise<boolean> {
  const label = `cleanup ${branch}`;
  const options = { fetch: !dryRun };
  assertTaskBranch(branch);
  const wsl = await probeCleanupWsl(ctx.run, ctx.target, branch, options);
  const cleanupCtx = { ...ctx, target: wsl.target };
  const wslOk = await execute(
    cleanupCtx,
    `${label} (wsl)`,
    wsl.refusal ? { kind: "refuse", reason: wsl.refusal } : planCleanup(branch, "wsl", wsl.state),
    dryRun,
  );
  if (!wslOk) return false;
  const hostState = await probeHost(ctx, branch, options);
  const hostPlan = planCleanup(branch, "host", hostState);
  const hostOk = await execute(ctx, `${label} (host)`, hostPlan, dryRun);
  if (!hostOk) return false;
  const task = /^task\/omi-(\d+)-/.exec(branch)?.[1];
  return task === undefined || (await retainRuns(cleanupCtx, label, new Set([task]), dryRun));
}

/**
 * Archives/deletes the worker logs of `tasks` in WSL ~/omi-runs (runs-retention.ts decides).
 * The listing is read-only and also runs with --dry-run; the changes are one bash script.
 */
export async function retainRuns(
  ctx: Context,
  label: string,
  tasks: ReadonlySet<string>,
  dryRun: boolean,
): Promise<boolean> {
  const listing = parseRunsListing(
    await runChecked(ctx.run, wslCommand(RUNS_LISTING, ctx.target, 30_000)),
  );
  const decisions = planRetention(listing, tasks, RUNS_RETENTION);
  const kept = decisions.filter((d) => d.action === "keep").length;
  const script = retentionScript(decisions);
  if (script === null) {
    console.log(`${label} (logs): done: nothing to archive or delete (${String(kept)} kept)`);
    return true;
  }
  for (const d of decisions.filter((x) => x.action !== "keep")) {
    const verb = dryRun ? `would ${d.action}` : d.action;
    console.log(`${label} (logs): ${verb} ${d.name} (${d.reason})`);
  }
  const command = wslCommand(script, ctx.target, 300_000);
  if (dryRun) {
    console.log(`${label} (logs): would run: ${formatCommand(command)}`);
    return true;
  }
  const result = await ctx.run(command);
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    console.error(`${label} (logs): failed (exit ${String(result.code)}): ${detail}`);
    return false;
  }
  console.log(`${label} (logs): ok (${String(kept)} kept)`);
  return true;
}

/** One-time sweep: the logs of every task whose Project Status is Done. */
export async function pruneRuns(ctx: Context, dryRun: boolean): Promise<boolean> {
  const done = (await readProject(ctx.run)).items.filter((i) => i.status === "Done");
  const tasks = new Set(
    done.flatMap((i) => {
      const key = /^OMI-(\d+)$/.exec(i.planKey ?? "")?.[1];
      return key === undefined ? [] : [key];
    }),
  );
  return retainRuns(ctx, "prune-runs", tasks, dryRun);
}

// ── execution ────────────────────────────────────────────────────────────────
async function execute(ctx: Context, label: string, plan: Plan, dryRun: boolean): Promise<boolean> {
  if (plan.kind === "done") {
    console.log(`${label}: done: ${plan.note}`);
    return true;
  }
  if (plan.kind === "refuse") {
    console.error(`${label}: refused: ${plan.reason}`);
    return false;
  }
  if (plan.note) console.log(`${label}: ${plan.note}`);
  for (const command of toCommands(plan.steps, ctx.target, ctx.hostCwd)) {
    if (dryRun) {
      console.log(`${label}: would run: ${formatCommand(command)}`);
      continue;
    }
    const result = await ctx.run(command);
    const out = result.stdout.trim();
    if (out) console.log(out);
    if (result.code !== 0) {
      console.error(`${label}: failed (exit ${String(result.code)}): ${result.stderr.trim()}`);
      return false;
    }
  }
  if (!dryRun) console.log(`${label}: ok`);
  return true;
}

/**
 * Backlog -> Ready. With no Issue number, the first promotable Backlog Issue in status.ts order.
 * The write is the ordinary set-status plan, so the readiness gate applies there too.
 */
export async function promoteCommand(
  ctx: Context,
  raw: string | undefined,
  dryRun: boolean,
): Promise<number> {
  let n: number;
  if (raw === undefined) {
    const [first] = promotableBacklog((await readProject(ctx.run)).items);
    if (first?.item.number == null) {
      console.log(
        "promote: no Backlog Issue with all blockers closed that passes the readiness gate",
      );
      return 0;
    }
    n = first.item.number;
  } else n = issueNumber(raw);
  const issue = await readIssue(ctx, n);
  const verdict = judgePromotion(n, {
    ...issue.readiness,
    status: issue.item?.status ?? null,
    blockers: issue.blockers,
    blockersTruncated: issue.blockersTruncated,
  });
  const plan: Plan =
    verdict.kind === "refuse"
      ? { kind: "refuse", reason: verdict.reason }
      : verdict.kind === "done"
        ? { kind: "done", note: verdict.note }
        : planSetStatus(n, "Ready", issue.field, issue.item, issue.readiness);
  return (await execute(ctx, `promote ${String(n)}`, plan, dryRun)) ? 0 : 1;
}

function issueNumber(raw: string | undefined): number {
  const m = /^#?(\d+)$/.exec(raw ?? "");
  if (!m?.[1]) throw new Error(`expected an Issue/PR number, got "${raw ?? ""}"`);
  return Number(m[1]);
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function taskBranch(raw: string | undefined): string {
  const branch = required(raw, "branch argument");
  assertTaskBranch(branch);
  return branch;
}

/** Read-only model/effort advice and model-aware quota selection. Never spends a Codex reset credit. */
export async function pickProfileCommand(
  ctx: Context,
  issue: number,
  kind: string,
  probe: boolean,
  json = false,
  model: string | null = null,
): Promise<number> {
  if (!(WORKER_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`--kind must be one of ${WORKER_KINDS.join(", ")}`);
  }
  const label = `pick-profile ${String(issue)}`;
  const quota = await readQuota(ctx.run, ctx.target, WORKER_PROFILES, QUOTA_SETTINGS, probe);
  if (!quota.available) {
    if (json)
      console.log(
        JSON.stringify({ ok: false, reason: `quota unavailable: ${quota.reason.slice(0, 200)}` }),
      );
    else console.error(`${label}: refused: quota unavailable (${quota.reason.slice(0, 200)})`);
    return 1;
  }
  const issueData = await readIssue(ctx, issue);
  const decision = inferComplexity({
    ...issueData.effortInput,
    hasLiveTests: kind === "claude+codex-live",
  });
  const result = pickProfile(
    kind as WorkerKind,
    quota.profiles,
    QUOTA_SETTINGS,
    quota.now,
    probe,
    model ?? EFFORT_POLICY.claude[decision.complexity].model,
  );
  const lines = formatPick(label, result);
  if (result.ok) {
    const chosen = result.chosen.map((candidate) => ({
      ...candidate,
      ...EFFORT_POLICY[candidate.tool][decision.complexity],
      ...decision,
    }));
    const reviewer = { ...EFFORT_POLICY.reviewer[decision.complexity], ...decision };
    if (json) console.log(JSON.stringify({ ...result, ...decision, chosen, reviewer }));
    else {
      for (const candidate of chosen) {
        lines.push(
          `  ${candidate.tool} model: ${candidate.model} effort: ${candidate.effort}` +
            ` (complexity ${candidate.complexity}: ${candidate.reason})`,
        );
      }
      lines.push(
        `reviewer: ${reviewer.model} ${reviewer.effort}` +
          ` (complexity ${reviewer.complexity}: ${reviewer.reason})`,
      );
      console.log(lines.join("\n"));
    }
  } else if (json) console.log(JSON.stringify(result));
  else console.error(lines.join("\n"));
  return result.ok ? 0 : 1;
}

// ── carried PASS (OMI-069) ───────────────────────────────────────────────────
const wslSide = (...argv: string[]): Step => ({ side: "wsl", argv });

/**
 * Git's verdict on a carried PASS of `head`, or undefined when the newest review on `head` is not
 * a carried one. Fetches first (not with --dry-run) so origin/develop is current.
 */
async function carryFor(
  ctx: Context,
  comments: readonly AuthoredComment[],
  head: string,
  dryRun: boolean,
): Promise<CarryJudgement | undefined> {
  const review = latestAgentReview(comments);
  if (!review?.carriedFrom || !head.startsWith(review.head)) return undefined;
  const git = wslGit(ctx.target);
  if (!dryRun) await ctx.run(git(["fetch", "--prune", "--quiet", "origin"]));
  return judgeCarryChain(ctx.run, git, comments, head);
}

async function carriesFor(
  ctx: Context,
  pulls: readonly ReferencingPull[],
  dryRun: boolean,
): Promise<Map<number, CarryJudgement>> {
  const out = new Map<number, CarryJudgement>();
  for (const p of pulls) {
    if (!p.merged || p.baseRefName !== BASE_BRANCH) continue;
    const judged = await carryFor(ctx, p.comments, p.headRefOid, dryRun);
    if (judged) out.set(p.number, judged);
  }
  return out;
}

/**
 * Merges origin/develop into the reviewed head and carries the PASS over the clean merge:
 * merge, check on the new head, push, comment. A conflict is aborted and refused with the files.
 */
export async function syncCommand(
  ctx: Context,
  branch: string,
  reviewedArg: string,
  dryRun: boolean,
): Promise<number> {
  const label = `sync ${branch}`;
  assertTaskBranch(branch);
  assertSha(reviewedArg);
  const git = wslGit(ctx.target);
  const stop = async (plan: Plan) => ((await execute(ctx, label, plan, dryRun)) ? 0 : 1);
  const state = await probeWsl(ctx, branch, { fetch: !dryRun, remote: true });
  const open = (await readExistingPulls(ctx, branch)).find(
    (p) => p.state === "OPEN" && p.baseRefName === BASE_BRANCH,
  );
  const pull = open ? await readPull(ctx, open.number) : null;
  const comments = pull?.comments ?? [];
  const resolved = await ctx.run(
    git(["rev-parse", "--verify", "--quiet", `${reviewedArg}^{commit}`]),
  );
  if (resolved.code !== 0)
    return stop({ kind: "refuse", reason: `${reviewedArg} is not a known commit` });
  const reviewed = resolved.stdout.trim();
  const sameHead = state.head === reviewed;
  const judge = async (sha: string): Promise<CarryJudgement> =>
    judgeCarryChain(ctx.run, git, comments, sha);
  const headCarry = sameHead
    ? null
    : await readCarryFacts(ctx.run, git, state.head).then(
        (facts) => judgeCarriedHead(facts, reviewed),
        (error: unknown): CarryJudgement => ({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
  const decision = decideSync({
    branch,
    reviewed,
    current: state.current,
    head: state.head,
    clean: state.clean,
    remote: state.remote,
    pull: pull && { number: pull.number, comments },
    developInHead:
      (await ctx.run(git(["merge-base", "--is-ancestor", `origin/${BASE_BRANCH}`, "HEAD"])))
        .code === 0,
    newest: latestAgentReview(comments),
    reviewedPass: await judge(reviewed),
    headCarry,
    headPass: !sameHead && agentReviewOn(comments, state.head) ? await judge(state.head) : null,
  });
  if (decision.kind === "refuse") return stop(decision);
  if (decision.kind === "done") return stop(decision);
  if (!pull) throw new Error("unreachable: sync decided to run without a PR");

  if (dryRun) {
    if (decision.kind === "merge") {
      const preview = await ctx.run(
        git(["merge-tree", "--write-tree", "--name-only", state.head, `origin/${BASE_BRANCH}`]),
      );
      const tree = parseMergeTree(preview.code, preview.stdout, preview.stderr);
      if (!tree.clean) return stop({ kind: "refuse", reason: conflictRefusal(branch, tree.files) });
    }
    const merge =
      decision.kind === "merge"
        ? [wslSide("git", "merge", "--no-edit", `origin/${BASE_BRANCH}`)]
        : [];
    const check =
      decision.kind === "resume" && decision.commented
        ? []
        : [{ side: "wsl", argv: ["npm", "run", "check"], needsNode: true } as const];
    const comment =
      decision.kind === "resume" && decision.commented
        ? []
        : [
            {
              side: "host",
              argv: [
                "gh",
                "pr",
                "comment",
                String(pull.number),
                "-R",
                REPO_SLUG,
                "--body-file",
                "-",
              ],
              input: carriedComment({
                newHead: "<new head>",
                reviewed,
                oldReviewBody: agentReviewOn(comments, reviewed)?.body ?? "",
                developCommit: "<origin/develop>",
                checkNote: "<npm run check result>",
              }),
            } as const,
          ];
    const steps = [...merge, ...check, wslSide("git", "push", "-u", "origin", branch), ...comment];
    return stop({
      kind: "run",
      note: "steps run one at a time; check, push and the comment only after a clean merge",
      steps,
    });
  }

  if (decision.kind === "merge") {
    const merged = await ctx.run(git(["merge", "--no-edit", `origin/${BASE_BRANCH}`]));
    if (merged.code !== 0) {
      const midMerge = await ctx.run(git(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]));
      if (midMerge.code !== 0) {
        return stop({
          kind: "refuse",
          reason: `git merge failed: ${merged.stderr.trim() || merged.stdout.trim()}`,
        });
      }
      const listed = await ctx.run(git(["diff", "--name-only", "--diff-filter=U"]));
      const files = listed.stdout.split("\n").filter(Boolean);
      await runChecked(ctx.run, git(["merge", "--abort"]));
      return stop({ kind: "refuse", reason: conflictRefusal(branch, files) });
    }
  }
  const newHead = (await runChecked(ctx.run, git(["rev-parse", "HEAD"]))).trim();
  const facts = await readCarryFacts(ctx.run, git, newHead);
  const carried = judgeCarriedHead(facts, reviewed);
  if (!carried.ok) {
    return stop({
      kind: "refuse",
      reason: `merge did not produce a clean sync: ${carried.reason}`,
    });
  }
  const commented = decision.kind === "resume" && decision.commented;
  if (!commented) {
    const checkPlan = planCheck(branch, newHead, await probeWsl(ctx, branch));
    if (!(await execute(ctx, `${label} (check)`, checkPlan, false))) return 1;
  }
  const after = await probeWsl(ctx, branch, { remote: true });
  if (
    !(await execute(ctx, `${label} (push)`, planPush(branch, after.local, after.remote), false))
  ) {
    return 1;
  }
  if (commented) return 0;
  const body = carriedComment({
    newHead,
    reviewed,
    oldReviewBody: agentReviewOn(comments, reviewed)?.body ?? "",
    developCommit: carried.developCommit,
    checkNote: `\`npm run check\` passed on \`${newHead.slice(0, 7)}\``,
  });
  const post: Plan = {
    kind: "run",
    steps: [
      {
        side: "host",
        argv: ["gh", "pr", "comment", String(pull.number), "-R", REPO_SLUG, "--body-file", "-"],
        input: body,
      },
    ],
  };
  return (await execute(ctx, `${label} (comment)`, post, false)) ? 0 : 1;
}

export async function main(argv: readonly string[], context?: Context): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      file: { type: "string" },
      head: { type: "string" },
      reviewed: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
      "comment-file": { type: "string" },
      "message-file": { type: "string" },
      prompt: { type: "string" },
      step: { type: "string" },
      worktree: { type: "string" },
      branch: { type: "string" },
      notes: { type: "string" },
      findings: { type: "string" },
      out: { type: "string" },
      profile: { type: "string" },
      resume: { type: "string" },
      kind: { type: "string", default: "claude" },
      probe: { type: "boolean", default: false },
      model: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [sub, a, b] = positionals;
  if (values.help || !sub) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const dry = values["dry-run"];
  const ctx: Context = context ?? {
    run: createProcessRunner(),
    target: wslTarget(),
    hostCwd: process.cwd(),
    isWindows: process.platform === "win32",
  };
  const label = `${sub}${a ? ` ${a}` : ""}`;
  const go = async (plan: Plan) => ((await execute(ctx, label, plan, dry)) ? 0 : 1);

  switch (sub) {
    case "prompt":
      return promptCommand(ctx, {
        number: issueNumber(a),
        step: values.step,
        worktree: values.worktree,
        branch: values.branch,
        notes: values.notes,
        findings: values.findings,
        out: values.out,
        dryRun: dry,
      });
    case "new-issue":
      return createIssue(ctx.run, required(values.file, "--file"), dry);
    case "set-status": {
      const n = issueNumber(a);
      const issue = await readIssue(ctx, n);
      return go(
        planSetStatus(n, required(b, "status argument"), issue.field, issue.item, issue.readiness),
      );
    }
    case "promote":
      return promoteCommand(ctx, a, dry);
    case "start-branch": {
      const n = issueNumber(a);
      const issue = await readIssue(ctx, n);
      const reasons = issueReadinessReasons(issue.readiness);
      if (reasons.length > 0)
        return go({ kind: "refuse", reason: `#${String(n)}: ${reasons.join("; ")}` });
      if (!issue.planKey) throw new Error(`#${String(n)} has no Plan Key on the Project`);
      const branch = taskBranchName(issue.planKey, required(b, "slug argument"));
      return go(planStartBranch(branch, await probeWsl(ctx, branch)));
    }
    case "push": {
      const branch = taskBranch(a);
      const state = await probeWsl(ctx, branch, { remote: true });
      return go(planPush(branch, state.local, state.remote));
    }
    case "check": {
      const branch = taskBranch(a);
      return go(planCheck(branch, required(values.head, "--head"), await probeWsl(ctx, branch)));
    }
    case "open-pr": {
      const n = issueNumber(a);
      const branch = taskBranch(b);
      const bodyFile = required(values["body-file"], "--body-file");
      const body = readFileSync(bodyFile, "utf8");
      const existing = await readExistingPulls(ctx, branch);
      return go(planOpenPr(n, branch, required(values.title, "--title"), bodyFile, body, existing));
    }
    case "merge": {
      const head = required(values.head, "--head");
      const pr = await readPull(ctx, issueNumber(a));
      const carry = await carryFor(ctx, pr.comments, pr.headRefOid, dry);
      return go(planMerge(pr, head, await readRequiredChecks(ctx.run), carry));
    }
    case "sync":
      return syncCommand(ctx, taskBranch(a), required(values.reviewed, "--reviewed"), dry);
    case "close": {
      const n = issueNumber(a);
      const comment = readFileSync(required(values["comment-file"], "--comment-file"), "utf8");
      const issue = await readIssue(ctx, n);
      const target = { number: n, ...issue };
      const carries = await carriesFor(ctx, issue.pulls, dry);
      return go(planClose(target, comment, issue.field, issue.item, issue.pulls, carries));
    }
    case "cleanup":
      return (await cleanup(ctx, taskBranch(a), dry)) ? 0 : 1;
    case "prune-runs":
      return (await pruneRuns(ctx, dry)) ? 0 : 1;
    case "pick-profile":
      return pickProfileCommand(
        ctx,
        issueNumber(a),
        values.kind,
        values.probe,
        values.json,
        values.model ?? null,
      );
    case "dispatch": {
      const issue = await readIssue(ctx, issueNumber(a));
      return dispatchCommand(ctx, {
        planKey: issue.planKey,
        role: issue.readiness.role,
        workflow: issue.readiness.workflow,
        complexity: inferComplexity(issue.effortInput).complexity,
        kind: values.kind,
        profile: required(values.profile, "--profile"),
        resume: values.resume ?? null,
        prompt: readFileSync(required(values.prompt, "--prompt"), "utf8"),
        dryRun: dry,
      });
    }
    case "worker-report": {
      const issue = await readIssue(ctx, issueNumber(a));
      return workerReportCommand(ctx, { planKey: issue.planKey, dryRun: dry });
    }
    case "commit-worker":
      return commitWorkerCommand(ctx, {
        branch: taskBranch(a),
        message: readFileSync(required(values["message-file"], "--message-file"), "utf8"),
        dryRun: dry,
      });
    case "review-comment": {
      const pr = await readPull(ctx, issueNumber(a));
      const n = linkedIssue(pr.body);
      if (n === null) {
        console.error(`${label}: refused: the PR body has no "Issue: #N" line`);
        return 1;
      }
      return reviewCommentCommand(ctx, {
        pr: pr.number,
        prState: pr.state,
        prHead: pr.headRefOid,
        issueBody: (await readIssue(ctx, n)).body,
        body: readFileSync(required(values.file, "--file"), "utf8"),
        dryRun: dry,
      });
    }
    default:
      console.error(`unknown subcommand "${sub}"\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`flow: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
