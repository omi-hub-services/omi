// Mechanical steps of /omi-next (ADR-0014). Run by the Coordinator on Windows; git steps go to
// the WSL checkout through wsl.exe (inside Linux they run in bash directly).
//   node tools/coordinator/flow.ts <subcommand> ... [--dry-run]
// Every subcommand reads the current state first: an already-done step prints "done:" and exits
// 0, an unsafe one prints "refused:" and exits 1, otherwise it runs (or with --dry-run prints)
// the argv it needs. Auth comes from the local gh/git logins; nothing token-like is printed.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
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
  WORKER_PROFILES,
  wslTarget,
  type WslTarget,
} from "./coordinator-settings.ts";
import {
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
} from "./flow-plans.ts";
import { localGit, probeBranch, wslGit, type ProbeOptions } from "./git-probe.ts";
import { graphql, readRequiredChecks } from "./github-reads.ts";
import { parsePull, PULL_FIELDS } from "./github-snapshot.ts";
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  authoredComments,
  commentBodies,
  nodes,
  optObject,
  optString,
  parseJson,
} from "./json-shape.ts";
import { createProcessRunner, formatCommand, runChecked, type Runner } from "./process-runner.ts";
import { formatPick, pickProfile, readQuota, WORKER_KINDS, type WorkerKind } from "./quota.ts";

const USAGE = `usage: node tools/coordinator/flow.ts <subcommand> [--dry-run]
  set-status <issue> <status>
  start-branch <issue> <slug>                 WSL: task/omi-NNN-<slug> from origin/${BASE_BRANCH}
  push <branch>                               WSL: git push -u origin <branch>
  check <branch> --head <sha>                 WSL: npm run check on exactly <sha>
  open-pr <issue> <branch> --title <t> --body-file <f>
  merge <pr> --head <sha>                     checks green, agent PASS @head, merge state clean
  close <issue> --comment-file <f>            tick AC from the review + comment + close + Done
  cleanup <branch>                            delete the merged local branch (WSL and host)
  pick-profile <issue> [--kind claude|codex|claude+codex-live] [--probe] [--json]
                                              worker profile by quota (--probe: 1 Haiku call/profile)`;

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
      area: fieldValueByName(name: "Area") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      planKey: fieldValueByName(name: "Plan Key") { ... on ProjectV2ItemFieldTextValue { text } }
    } } } }
}`;

interface IssueContext {
  readonly effortInput: EffortInput;
  readonly field: StatusField;
  readonly item: IssueItem | null;
  readonly planKey: string | null;
  readonly state: string;
  readonly body: string;
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
  const select = (name: string) => optString(optObject(item?.[name], name)?.name, `${name}.name`);
  return {
    effortInput: {
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
  const wslState = await probeWsl(ctx, branch, options);
  const wslOk = await execute(ctx, `${label} (wsl)`, planCleanup(branch, "wsl", wslState), dryRun);
  const hostState = await probeHost(ctx, branch, options);
  const hostPlan = planCleanup(branch, "host", hostState);
  return (await execute(ctx, `${label} (host)`, hostPlan, dryRun)) && wslOk;
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

/** Read-only model/effort advice after quota selection. Never spends a Codex reset credit. */
export async function pickProfileCommand(
  ctx: Context,
  issue: number,
  kind: string,
  probe: boolean,
  json = false,
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
  const result = pickProfile(kind as WorkerKind, quota.profiles, QUOTA_SETTINGS, quota.now, probe);
  const lines = formatPick(label, result);
  if (result.ok) {
    const issueData = await readIssue(ctx, issue);
    const decision = inferComplexity({
      ...issueData.effortInput,
      hasLiveTests: kind === "claude+codex-live",
    });
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

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      head: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
      "comment-file": { type: "string" },
      kind: { type: "string", default: "claude" },
      probe: { type: "boolean", default: false },
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
  const ctx: Context = {
    run: createProcessRunner(),
    target: wslTarget(),
    hostCwd: process.cwd(),
    isWindows: process.platform === "win32",
  };
  const label = `${sub}${a ? ` ${a}` : ""}`;
  const go = async (plan: Plan) => ((await execute(ctx, label, plan, dry)) ? 0 : 1);

  switch (sub) {
    case "set-status": {
      const n = issueNumber(a);
      const issue = await readIssue(ctx, n);
      return go(planSetStatus(n, required(b, "status argument"), issue.field, issue.item));
    }
    case "start-branch": {
      const n = issueNumber(a);
      const issue = await readIssue(ctx, n);
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
      return go(planMerge(pr, head, await readRequiredChecks(ctx.run)));
    }
    case "close": {
      const n = issueNumber(a);
      const comment = readFileSync(required(values["comment-file"], "--comment-file"), "utf8");
      const issue = await readIssue(ctx, n);
      const target = { number: n, ...issue };
      return go(planClose(target, comment, issue.field, issue.item, issue.pulls));
    }
    case "cleanup":
      return (await cleanup(ctx, taskBranch(a), dry)) ? 0 : 1;
    case "pick-profile":
      return pickProfileCommand(ctx, issueNumber(a), values.kind, values.probe, values.json);
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
