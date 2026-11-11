// Pure decisions for the flow script: given observed state, a step is already done, must be
// refused, or needs these argv steps. Re-running a step after success always yields "done", so
// nothing (PR, comment, status change, branch) is created twice.
import {
  BASE_BRANCH,
  CLOSE_EVIDENCE_MARKER,
  REPO_SLUG,
  type WslTarget,
} from "./coordinator-settings.ts";
import { issueReadinessReasons, type IssueReadiness } from "./issue-readiness.ts";
import { parseAcLines, tickAcceptanceCriteria } from "./acceptance-criteria.ts";
import {
  classifyReview,
  foreignVerdictAuthors,
  latestAgentReview,
  linkedIssue,
  summarizeChecks,
  type OpenPull,
} from "./github-snapshot.ts";
import type { AuthoredComment } from "./json-shape.ts";
import { joinSteps, WSL_NODE_ENV, wslCommand, type Command } from "./process-runner.ts";

/** Where a step runs: `gh` on the Coordinator host, git in the WSL checkout, or git on the host. */
export type StepSide = "host" | "wsl";

export interface Step {
  readonly side: StepSide;
  readonly argv: readonly string[];
  readonly input?: string;
  /** WSL step needs Node/npm, which a non-interactive login shell only gets from nvm. */
  readonly needsNode?: true;
}

export type Plan =
  | { readonly kind: "done"; readonly note: string }
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "run"; readonly steps: readonly Step[]; readonly note?: string };

/**
 * Consecutive WSL steps become one `bash -lc` payload (one wsl.exe call, `&&`-chained, each
 * argument quoted); host steps stay plain argv. `hostCwd` applies to host git steps.
 */
export function toCommands(steps: readonly Step[], target: WslTarget, hostCwd: string): Command[] {
  const out: Command[] = [];
  let group: Step[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const prefix = group.some((s) => s.needsNode) ? `${WSL_NODE_ENV} ` : "";
    const long = group.some((s) => s.needsNode) ? 900_000 : undefined;
    out.push(wslCommand(prefix + joinSteps(group.map((s) => s.argv)), target, long));
    group = [];
  };
  for (const step of steps) {
    if (step.side === "wsl") {
      group.push(step);
      continue;
    }
    flush();
    const [file = "", ...args] = step.argv;
    out.push({
      file,
      args,
      ...(file === "git" ? { cwd: hostCwd } : {}),
      ...(step.input === undefined ? {} : { input: step.input }),
    });
  }
  flush();
  return out;
}

const done = (note: string): Plan => ({ kind: "done", note });
const refuse = (reason: string): Plan => ({ kind: "refuse", reason });
const host = (...argv: string[]): Step => ({ side: "host", argv });
const wsl = (...argv: string[]): Step => ({ side: "wsl", argv });

// ── names ────────────────────────────────────────────────────────────────────
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TASK_BRANCH = /^task\/omi-\d{3}-[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{7,40}$/;

export function taskBranchName(planKey: string, slug: string): string {
  const m = /^OMI-(\d{3})$/.exec(planKey);
  if (!m?.[1]) throw new Error(`plan key ${planKey} is not OMI-NNN`);
  if (!SLUG.test(slug)) throw new Error(`slug "${slug}" must be lowercase kebab-case`);
  return `task/omi-${m[1]}-${slug}`;
}

/** Only task branches are pushed or deleted; never develop, main or arbitrary refs. */
export function assertTaskBranch(branch: string): void {
  if (!TASK_BRANCH.test(branch)) {
    throw new Error(`"${branch}" is not a task branch (task/omi-NNN-slug)`);
  }
}

export function assertSha(sha: string): void {
  if (!SHA.test(sha)) throw new Error(`"${sha}" is not a commit SHA (7–40 lowercase hex)`);
}

// ── set-status ───────────────────────────────────────────────────────────────
export interface StatusField {
  readonly projectId: string;
  readonly fieldId: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

export interface IssueItem {
  readonly itemId: string;
  readonly status: string | null;
}

export function planSetStatus(
  issue: number,
  wanted: string,
  field: StatusField,
  item: IssueItem | null,
  readiness?: IssueReadiness,
): Plan {
  if (wanted === "Ready" || wanted === "In Progress") {
    if (!readiness) return refuse(`#${String(issue)}: missing readiness data`);
    const reasons = issueReadinessReasons(readiness);
    if (reasons.length > 0) return refuse(`#${String(issue)}: ${reasons.join("; ")}`);
  }
  const option = field.options.find((o) => o.name === wanted);
  if (!option) {
    return refuse(
      `unknown Status "${wanted}"; options: ${field.options.map((o) => o.name).join(", ")}`,
    );
  }
  if (!item) return refuse(`#${String(issue)} is not an item of the Project`);
  if (item.status === wanted) return done(`#${String(issue)} Status is already ${wanted}`);
  return {
    kind: "run",
    note: `#${String(issue)} Status ${item.status ?? "(none)"} -> ${wanted}`,
    steps: [
      host(
        "gh",
        "project",
        "item-edit",
        "--id",
        item.itemId,
        "--project-id",
        field.projectId,
        "--field-id",
        field.fieldId,
        "--single-select-option-id",
        option.id,
      ),
    ],
  };
}

// ── local git state (WSL or host checkout) ───────────────────────────────────
export interface BranchState {
  readonly current: string;
  /** SHA of refs/heads/<branch>, or null when it does not exist. */
  readonly local: string | null;
  /** Tracked files modified (untracked files are ignored). */
  readonly dirty: boolean;
}

export function planStartBranch(branch: string, state: BranchState): Plan {
  assertTaskBranch(branch);
  if (state.current === branch) return done(`WSL checkout is already on ${branch}`);
  if (state.dirty)
    return refuse(`WSL checkout on ${state.current} has uncommitted tracked changes`);
  // Kept for resuming: a re-run of start-branch after the branch was created (worker started,
  // checkout moved elsewhere, session restarted) switches back instead of failing on `-c`.
  if (state.local !== null) {
    return {
      kind: "run",
      note: `${branch} exists; switching to it`,
      steps: [wsl("git", "switch", branch)],
    };
  }
  return {
    kind: "run",
    steps: [
      wsl("git", "fetch", "origin"),
      wsl("git", "switch", "--no-track", "-c", branch, `origin/${BASE_BRANCH}`),
    ],
  };
}

export function planPush(branch: string, local: string | null, remote: string | null): Plan {
  assertTaskBranch(branch);
  if (local === null) return refuse(`${branch} does not exist in the WSL checkout`);
  if (remote === local) return done(`origin/${branch} is already at ${local.slice(0, 7)}`);
  // No force: a diverged remote makes git refuse, which is the wanted outcome.
  return { kind: "run", steps: [wsl("git", "push", "-u", "origin", branch)] };
}

/** `npm run check` in WSL, only on the exact reviewed head with a clean tree. */
export function planCheck(
  branch: string,
  expectedHead: string,
  state: { readonly current: string; readonly head: string; readonly clean: boolean },
): Plan {
  assertTaskBranch(branch);
  assertSha(expectedHead);
  if (state.current !== branch) return refuse(`WSL checkout is on ${state.current}, not ${branch}`);
  if (!state.head.startsWith(expectedHead)) {
    return refuse(`WSL HEAD is ${state.head.slice(0, 7)}, not ${expectedHead}`);
  }
  // Untracked files count too: tsc, eslint and prettier would check them.
  if (!state.clean) return refuse("WSL checkout has uncommitted or untracked changes");
  return {
    kind: "run",
    note: `npm run check on ${branch} @ ${state.head.slice(0, 7)}`,
    steps: [{ side: "wsl", argv: ["npm", "run", "check"], needsNode: true }],
  };
}

export interface CleanupState extends BranchState {
  /** refs/heads/<branch> is an ancestor of origin/develop. */
  readonly merged: boolean;
  /** No tracked or untracked (non-ignored) changes in the checkout. */
  readonly clean: boolean;
  readonly worktree?: {
    readonly path: string;
    readonly mainPath: string;
    readonly mainBranch: string | undefined;
    readonly changes: string;
  };
}

export function planCleanup(branch: string, side: StepSide, state: CleanupState | null): Plan {
  assertTaskBranch(branch);
  const where = side === "wsl" ? "WSL checkout" : "host checkout";
  if (state === null) return done(`no ${where}; nothing to clean`);
  if (state.local === null) return done(`${branch} is already gone from the ${where}`);
  if (state.worktree?.changes) {
    return refuse(`worktree ${state.worktree.path} has changes:\n${state.worktree.changes}`);
  }
  if (!state.merged) return refuse(`${branch} is not merged into origin/${BASE_BRANCH} (${where})`);
  const step = (...argv: string[]): Step => ({ side, argv });
  if (state.worktree) {
    const tree = state.worktree;
    const git = (...args: string[]) => step("git", "-C", tree.mainPath, ...args);
    return {
      kind: "run",
      steps: [
        step("git", "-C", tree.path, "fetch", "origin"),
        step("git", "-C", tree.path, "switch", "--detach", `origin/${BASE_BRANCH}`),
        step("git", "-C", tree.path, "branch", "-d", branch),
        git("worktree", "remove", "--", tree.path),
        ...(tree.mainBranch === `refs/heads/${BASE_BRANCH}`
          ? [git("merge", "--ff-only", `origin/${BASE_BRANCH}`)]
          : []),
      ],
    };
  }
  const leave =
    state.current === branch
      ? [
          step("git", "switch", BASE_BRANCH),
          step("git", "merge", "--ff-only", `origin/${BASE_BRANCH}`),
        ]
      : [];
  // A branch with no commits of its own also counts as merged; work that only exists as
  // uncommitted or untracked files on it must not be walked away from.
  if (leave.length > 0 && !state.clean) {
    return refuse(`${where} is on ${branch} with uncommitted or untracked changes`);
  }
  // -D is safe here: merged into origin/develop was verified above.
  return { kind: "run", steps: [...leave, step("git", "branch", "-D", branch)] };
}

// ── pull requests ────────────────────────────────────────────────────────────
export interface ExistingPull {
  readonly number: number;
  readonly state: string;
  readonly url: string;
  readonly baseRefName: string;
}

export function planOpenPr(
  issue: number,
  branch: string,
  title: string,
  bodyFile: string,
  body: string,
  existing: readonly ExistingPull[],
): Plan {
  assertTaskBranch(branch);
  const live = existing.find(
    (p) => (p.state === "OPEN" || p.state === "MERGED") && p.baseRefName === BASE_BRANCH,
  );
  if (live)
    return done(
      `PR #${String(live.number)} (${live.state}) already exists for ${branch}: ${live.url}`,
    );
  const link = linkedIssue(body);
  if (link !== issue) {
    const found = link === null ? "none" : `#${String(link)}`;
    return refuse(`PR body must contain a line "Issue: #${String(issue)}" (found ${found})`);
  }
  if (!title.trim()) return refuse("PR title is empty");
  return {
    kind: "run",
    steps: [
      host(
        "gh",
        "pr",
        "create",
        "-R",
        REPO_SLUG,
        "--base",
        BASE_BRANCH,
        "--head",
        branch,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ),
    ],
  };
}

export interface PullForMerge extends OpenPull {
  readonly state: string;
  readonly mergeCommit: string | null;
}

/** GitHub merge states in which `gh pr merge` can merge without bypassing anything. */
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS"]);

const shortSha = (sha: string) => sha.slice(0, 7);
const reviewSeen = (
  r: { verdict: string; head: string } | null,
  comments: readonly AuthoredComment[],
) => {
  const seen = r ? `newest: ${r.verdict} @${shortSha(r.head)}` : "none found";
  const foreign = foreignVerdictAuthors(comments);
  return foreign.length > 0 ? `${seen}; ignored VERDICT from ${foreign.join(", ")}` : seen;
};

export function planMerge(
  pr: PullForMerge,
  expectedHead: string,
  required: readonly string[],
): Plan {
  assertSha(expectedHead);
  const n = `PR #${String(pr.number)}`;
  const sameHead = pr.headRefOid.startsWith(expectedHead);
  if (pr.state === "MERGED") {
    return sameHead
      ? done(`${n} is already merged (${pr.mergeCommit?.slice(0, 7) ?? "?"})`)
      : refuse(`${n} was merged at ${pr.headRefOid.slice(0, 7)}, not ${expectedHead}`);
  }
  if (pr.state !== "OPEN") return refuse(`${n} is ${pr.state}`);
  if (!sameHead) {
    return refuse(`${n} head is ${pr.headRefOid.slice(0, 7)}, not the reviewed ${expectedHead}`);
  }
  if (pr.baseRefName !== BASE_BRANCH) {
    return refuse(
      `${n} targets ${pr.baseRefName}; only task PRs into ${BASE_BRANCH} are merged here`,
    );
  }
  if (pr.isDraft) return refuse(`${n} is a draft`);
  const checks = summarizeChecks(pr.checks, required);
  if (checks.overall !== "pass") {
    const detail = [
      checks.failing.length > 0 ? `failing: ${checks.failing.join(", ")}` : "",
      checks.pending.length > 0 ? `pending: ${checks.pending.join(", ")}` : "",
      checks.missingRequired.length > 0 ? `missing: ${checks.missingRequired.join(", ")}` : "",
    ].filter(Boolean);
    return refuse(`${n} checks are not green (${detail.join("; ") || checks.overall})`);
  }
  const review = classifyReview(pr).agent;
  if (review?.verdict !== "PASS" || !review.current) {
    return refuse(
      `${n} needs an agent review PASS on head ${shortSha(pr.headRefOid)} (${reviewSeen(review, pr.comments)})`,
    );
  }
  if (!MERGEABLE_STATES.has(pr.mergeStateStatus)) {
    const hint = pr.mergeStateStatus === "BEHIND" ? `; update it from ${BASE_BRANCH} first` : "";
    return refuse(`${n} merge state is ${pr.mergeStateStatus}, not CLEAN or HAS_HOOKS${hint}`);
  }
  return {
    kind: "run",
    steps: [
      host(
        "gh",
        "pr",
        "merge",
        String(pr.number),
        "-R",
        REPO_SLUG,
        "--merge",
        "--match-head-commit",
        pr.headRefOid,
      ),
    ],
  };
}

// ── close ────────────────────────────────────────────────────────────────────
export interface IssueForClose {
  readonly number: number;
  readonly state: string;
  readonly body: string;
  readonly comments: readonly string[];
}

/**
 * A PR of this repository that references the Issue (Issue timeline cross-references; PRs of
 * other repositories are dropped when the timeline is parsed).
 */
export interface ReferencingPull {
  readonly number: number;
  readonly merged: boolean;
  /** ISO 8601 UTC timestamp; null while unmerged. */
  readonly mergedAt: string | null;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly body: string;
  readonly comments: readonly AuthoredComment[];
}

/**
 * Ticks the Issue's AC from the `AC-<n>` lines of the Coordinator's agent review PASS on the
 * merged head of the most recently merged (by `mergedAt`) PR into develop with `Issue: #N`.
 * Refuses on a missing PASS, a missing line or a `not met`; done when every box is ticked.
 */
export function planTickCriteria(issue: IssueForClose, pulls: readonly ReferencingPull[]): Plan {
  const n = String(issue.number);
  // GitHub's ISO timestamps share one format (UTC, `Z`), so they sort as strings.
  const pr = pulls
    .filter((p) => p.merged && p.baseRefName === BASE_BRANCH)
    .filter((p) => linkedIssue(p.body) === issue.number)
    .sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? ""))
    .at(-1);
  if (!pr) return refuse(`no merged PR into ${BASE_BRANCH} has the line "Issue: #${n}"`);
  const p = `PR #${String(pr.number)}`;
  const review = latestAgentReview(pr.comments);
  if (review?.verdict !== "PASS" || !pr.headRefOid.startsWith(review.head)) {
    const want = `${p} needs an agent review PASS on its merged head ${shortSha(pr.headRefOid)}`;
    return refuse(`${want} (${reviewSeen(review, pr.comments)})`);
  }
  const tick = tickAcceptanceCriteria(issue.body, parseAcLines(review.body));
  if (tick.kind === "refuse") return refuse(`#${n} AC: ${tick.reason} (review on ${p})`);
  if (tick.newly === 0) return done(`all ${String(tick.total)} AC already ticked`);
  return {
    kind: "run",
    note: `ticks ${String(tick.newly)} of ${String(tick.total)} AC from the review on ${p}`,
    steps: [
      {
        side: "host",
        argv: ["gh", "issue", "edit", n, "-R", REPO_SLUG, "--body-file", "-"],
        input: tick.body,
      },
    ],
  };
}

export function withEvidenceMarker(comment: string): string {
  return comment.includes(CLOSE_EVIDENCE_MARKER)
    ? comment
    : `${comment.trimEnd()}\n\n${CLOSE_EVIDENCE_MARKER}\n`;
}

/**
 * Tick AC, comment (once), close (once), then Status Done (once); each part is skipped when
 * done. An Issue already commented, closed and Done is done without re-checking AC.
 */
export function planClose(
  issue: IssueForClose,
  comment: string,
  field: StatusField,
  item: IssueItem | null,
  pulls: readonly ReferencingPull[],
): Plan {
  if (!comment.trim()) return refuse("closing comment is empty");
  const statusPlan = planSetStatus(issue.number, "Done", field, item);
  if (statusPlan.kind === "refuse") return statusPlan;
  const n = String(issue.number);
  const commented = issue.comments.some((c) => c.includes(CLOSE_EVIDENCE_MARKER));
  if (commented && issue.state === "CLOSED" && statusPlan.kind === "done") {
    return done(`#${n}: evidence comment exists; already closed; Status already Done`);
  }
  const tick = planTickCriteria(issue, pulls);
  if (tick.kind === "refuse") return tick;
  const steps: Step[] = tick.kind === "run" ? [...tick.steps] : [];
  const notes: string[] = tick.note ? [tick.note] : [];
  if (commented) notes.push("evidence comment exists");
  else {
    steps.push({
      side: "host",
      argv: ["gh", "issue", "comment", n, "-R", REPO_SLUG, "--body-file", "-"],
      input: withEvidenceMarker(comment),
    });
  }
  if (issue.state === "CLOSED") notes.push("already closed");
  else steps.push(host("gh", "issue", "close", n, "-R", REPO_SLUG, "--reason", "completed"));
  if (statusPlan.kind === "done") notes.push("Status already Done");
  else steps.push(...statusPlan.steps);
  if (steps.length === 0) return done(`#${n}: ${notes.join("; ")}`);
  return notes.length > 0 ? { kind: "run", steps, note: notes.join("; ") } : { kind: "run", steps };
}
