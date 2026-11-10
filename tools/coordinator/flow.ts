// Mechanical steps of /omi-next (ADR-0014). Run by the Coordinator on Windows; git steps go to
// the WSL checkout through wsl.exe (inside Linux they run in bash directly).
//   node tools/coordinator/flow.ts <subcommand> ... [--dry-run]
// Every subcommand reads the current state first: an already-done step prints "done:" and exits
// 0, an unsafe one prints "refused:" and exits 1, otherwise it runs (or with --dry-run prints)
// the argv it needs. Auth comes from the local gh/git logins; nothing token-like is printed.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  BASE_BRANCH,
  OWNER,
  PROJECT_NUMBER,
  REPO,
  REPO_SLUG,
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
  type CleanupState,
  type ExistingPull,
  type IssueItem,
  type Plan,
  type PullForMerge,
  type StatusField,
} from "./flow-plans.ts";
import { branchProbe, parseBranchProbe, type ProbeOptions } from "./git-probe.ts";
import { graphql, readRequiredChecks } from "./github-reads.ts";
import { parseCheck } from "./github-snapshot.ts";
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
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

const USAGE = `usage: node tools/coordinator/flow.ts <subcommand> [--dry-run]
  set-status <issue> <status>
  start-branch <issue> <slug>                 WSL: task/omi-NNN-<slug> from origin/${BASE_BRANCH}
  push <branch>                               WSL: git push -u origin <branch>
  check <branch> --head <sha>                 WSL: npm run check on exactly <sha>
  open-pr <issue> <branch> --title <t> --body-file <f>
  merge <pr> --head <sha>                     only when required checks are green
  close <issue> --comment-file <f>            comment + close + Status Done
  cleanup <branch>                            delete the merged local branch (WSL and host)`;

interface Context {
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
  repository(owner: $owner, name: $repo) { issue(number: $number) { state
    comments(last: 100) { nodes { body } }
    projectItems(first: 20) { nodes { id project { id }
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      planKey: fieldValueByName(name: "Plan Key") { ... on ProjectV2ItemFieldTextValue { text } }
    } } } }
}`;

interface IssueContext {
  readonly field: StatusField;
  readonly item: IssueItem | null;
  readonly planKey: string | null;
  readonly state: string;
  readonly comments: readonly string[];
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
  return {
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
    comments: nodes(issue, "comments", "issue").map((c) =>
      asString(asObject(c, "comment").body, "comment.body"),
    ),
  };
}

const PULL_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    number state isDraft baseRefName headRefOid mergeable mergeStateStatus mergeCommit { oid }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
      __typename
      ... on CheckRun { name status conclusion }
      ... on StatusContext { context state }
    } } } } } }
  } }
}`;

async function readPull(ctx: Context, number: number): Promise<PullForMerge> {
  const data = await graphql(ctx.run, PULL_QUERY, { owner: OWNER, repo: REPO, number });
  const pr = optObject(asObject(data.repository, "repository").pullRequest, "pullRequest");
  if (!pr) throw new Error(`PR #${String(number)} not found in ${REPO_SLUG}`);
  const commit = nodes(pr, "commits", "pr")[0];
  const rollup = commit
    ? optObject(asObject(asObject(commit, "commit").commit, "commit").statusCheckRollup, "rollup")
    : null;
  return {
    number: asNumber(pr.number, "pr.number"),
    state: asString(pr.state, "pr.state"),
    isDraft: asBoolean(pr.isDraft, "pr.isDraft"),
    baseRefName: asString(pr.baseRefName, "pr.baseRefName"),
    headRefOid: asString(pr.headRefOid, "pr.headRefOid"),
    mergeable: asString(pr.mergeable, "pr.mergeable"),
    mergeStateStatus: asString(pr.mergeStateStatus, "pr.mergeStateStatus"),
    mergeCommit: optString(optObject(pr.mergeCommit, "mergeCommit")?.oid, "mergeCommit.oid"),
    checks: rollup
      ? nodes(rollup, "contexts", "rollup").map((c, i) => parseCheck(c, `checks[${String(i)}]`))
      : [],
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
async function probeWsl(ctx: Context, branch: string, options?: ProbeOptions) {
  const stdout = await runChecked(ctx.run, wslCommand(branchProbe(branch, options), ctx.target));
  return parseBranchProbe(stdout);
}

/** The Windows checkout (cwd), if it is a checkout of this repository; Linux has none. */
async function probeHost(ctx: Context, branch: string): Promise<CleanupState | null> {
  if (!ctx.isWindows) return null;
  const git = (...args: string[]) => ctx.run({ file: "git", args, cwd: ctx.hostCwd });
  const origin = await git("remote", "get-url", "origin");
  if (origin.code !== 0 || !origin.stdout.includes(REPO_SLUG)) return null;
  await git("fetch", "--prune", "--quiet", "origin");
  const ref = `refs/heads/${branch}`;
  const local = await git("rev-parse", "--verify", "--quiet", ref);
  const merged = await git("merge-base", "--is-ancestor", ref, `origin/${BASE_BRANCH}`);
  const current = await git("rev-parse", "--abbrev-ref", "HEAD");
  const tracked = await git("status", "--porcelain", "--untracked-files=no");
  const all = await git("status", "--porcelain");
  return {
    current: current.stdout.trim(),
    local: local.code === 0 ? local.stdout.trim() : null,
    merged: merged.code === 0,
    dirty: tracked.stdout.trim() !== "",
    clean: all.stdout.trim() === "",
  };
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
      const target = { number: n, state: issue.state, comments: issue.comments };
      return go(planClose(target, comment, issue.field, issue.item));
    }
    case "cleanup": {
      const branch = taskBranch(a);
      const wslState = await probeWsl(ctx, branch, { fetch: true });
      const wslOk = await execute(ctx, `${label} (wsl)`, planCleanup(branch, "wsl", wslState), dry);
      const hostState = await probeHost(ctx, branch);
      const hostOk = await execute(
        ctx,
        `${label} (host)`,
        planCleanup(branch, "host", hostState),
        dry,
      );
      return wslOk && hostOk ? 0 : 1;
    }
    default:
      console.error(`unknown subcommand "${sub}"\n${USAGE}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`flow: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
