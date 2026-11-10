// Pure decisions for the flow script: given observed state, a step is already done, must be
// refused, or needs these argv steps. Re-running a step after success always yields "done", so
// nothing (PR, comment, status change, branch) is created twice.
import {
  BASE_BRANCH,
  CLOSE_EVIDENCE_MARKER,
  REPO_SLUG,
  type WslTarget,
} from "./coordinator-settings.ts";
import { summarizeChecks, type CheckContext } from "./github-snapshot.ts";
import { joinSteps, wslCommand, type Command } from "./process-runner.ts";

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

const NODE_ENV = "[ -s $HOME/.nvm/nvm.sh ] && . $HOME/.nvm/nvm.sh >/dev/null 2>&1;";

/**
 * Consecutive WSL steps become one `bash -lc` payload (one wsl.exe call, `&&`-chained, each
 * argument quoted); host steps stay plain argv. `hostCwd` applies to host git steps.
 */
export function toCommands(steps: readonly Step[], target: WslTarget, hostCwd: string): Command[] {
  const out: Command[] = [];
  let group: Step[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const prefix = group.some((s) => s.needsNode) ? `${NODE_ENV} ` : "";
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
): Plan {
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
}

export function planCleanup(branch: string, side: StepSide, state: CleanupState | null): Plan {
  assertTaskBranch(branch);
  const where = side === "wsl" ? "WSL checkout" : "host checkout";
  if (state === null) return done(`no ${where}; nothing to clean`);
  if (state.local === null) return done(`${branch} is already gone from the ${where}`);
  if (!state.merged) return refuse(`${branch} is not merged into origin/${BASE_BRANCH} (${where})`);
  const step = (...argv: string[]): Step => ({ side, argv });
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
  const link = /^Issue:\s*#(\d+)\b/m.exec(body)?.[1];
  if (link !== String(issue)) {
    return refuse(
      `PR body must contain a line "Issue: #${String(issue)}" (found ${link ? `#${link}` : "none"})`,
    );
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

export interface PullForMerge {
  readonly number: number;
  readonly state: string;
  readonly isDraft: boolean;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly mergeable: string;
  readonly mergeStateStatus: string;
  readonly mergeCommit: string | null;
  readonly checks: readonly CheckContext[];
}

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
  if (pr.mergeable === "CONFLICTING") return refuse(`${n} has merge conflicts`);
  if (pr.mergeStateStatus === "BEHIND")
    return refuse(`${n} is behind ${BASE_BRANCH}; update it first`);
  const checks = summarizeChecks(pr.checks, required);
  if (checks.overall !== "pass") {
    const detail = [
      checks.failing.length > 0 ? `failing: ${checks.failing.join(", ")}` : "",
      checks.pending.length > 0 ? `pending: ${checks.pending.join(", ")}` : "",
      checks.missingRequired.length > 0 ? `missing: ${checks.missingRequired.join(", ")}` : "",
    ].filter(Boolean);
    return refuse(`${n} checks are not green (${detail.join("; ") || checks.overall})`);
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
  readonly comments: readonly string[];
}

export function withEvidenceMarker(comment: string): string {
  return comment.includes(CLOSE_EVIDENCE_MARKER)
    ? comment
    : `${comment.trimEnd()}\n\n${CLOSE_EVIDENCE_MARKER}\n`;
}

/** Comment (once), close (once), then Status Done (once); each part is skipped when done. */
export function planClose(
  issue: IssueForClose,
  comment: string,
  field: StatusField,
  item: IssueItem | null,
): Plan {
  if (!comment.trim()) return refuse("closing comment is empty");
  const statusPlan = planSetStatus(issue.number, "Done", field, item);
  if (statusPlan.kind === "refuse") return statusPlan;
  const n = String(issue.number);
  const steps: Step[] = [];
  const notes: string[] = [];
  if (issue.comments.some((c) => c.includes(CLOSE_EVIDENCE_MARKER)))
    notes.push("evidence comment exists");
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
