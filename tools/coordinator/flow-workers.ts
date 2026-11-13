// I/O of the worker subcommands of flow.ts (OMI-077): dispatch, worker-report, commit-worker and
// review-comment. The caller (flow.ts) has already read the Issue/PR; everything here goes
// through the injectable runner, and the pure decisions live in worker-launch.ts,
// worker-report.ts, worker-commit.ts and review-verdict.ts. Same contract as the other
// subcommands: "refused:" and exit 1 for a gate, --dry-run changes nothing.
import { countAcceptanceCriteria } from "./acceptance-criteria.ts";
import "../register-ts-imports.ts";
const { stepQualitySchema } = await import("../../src/application/contracts/workflow.ts");
const { resolveQualityPolicy } = await import("../../src/domain/workflows/workflow-policy.ts");
import type { Complexity } from "./effort-policy.ts";
import {
  COORDINATOR_LOGIN,
  EFFORT_POLICY,
  REPO_SLUG,
  WORKER_PROFILES,
  type WslTarget,
} from "./coordinator-settings.ts";
import { assertTaskBranch } from "./flow-plans.ts";
import { wslGit } from "./git-probe.ts";
import {
  formatCommand,
  runChecked,
  wslCommand,
  type Command,
  type Runner,
} from "./process-runner.ts";
import { checkReview } from "./review-verdict.ts";
import { judgeCommit, STAGE_PATHS } from "./worker-commit.ts";
import {
  claudeLaunchPayload,
  codexLaunchPayload,
  NATIVE_RESUME_HEADER,
  runsPath,
} from "./worker-launch.ts";
import {
  formatReport,
  validateWorkerResult,
  isCodexLog,
  newestLogCommand,
  parseClaudeReport,
  parseCodexReport,
  type WorkerReport,
} from "./worker-report.ts";

export interface WorkerCtx {
  readonly toolRoot?: string;
  readonly run: Runner;
  readonly target: WslTarget;
}

const refuse = (label: string, reason: string): number => {
  console.error(`${label}: refused: ${reason}`);
  return 1;
};
const would = (label: string, command: Command): void => {
  console.log(`${label}: would run: ${formatCommand(command)}`);
};

/** A foreground worker may run for hours; the runner's 2-minute default would kill it. */
const WORKER_TIMEOUT_MS = 8 * 3_600_000;

export interface DispatchInput {
  readonly planKey: string | null;
  readonly role: string | null;
  readonly workflow: string | null;
  readonly complexity: Complexity;
  readonly kind: string;
  readonly profile: string;
  readonly resume: string | null;
  /** Text of the prompt file; with `resume` it is the follow-up message. */
  readonly prompt: string;
  readonly dryRun: boolean;
}

/**
 * Writes the rendered prompt unchanged to WSL
 * `~/omi-runs/omi-NNN-prompt.md`, then runs the worker in the foreground; the Coordinator's
 * harness backgrounds this command.
 */
export async function dispatchCommand(ctx: WorkerCtx, input: DispatchInput): Promise<number> {
  const label = `dispatch ${input.planKey ?? "?"}`;
  const task = /^OMI-(\d+)$/.exec(input.planKey ?? "")?.[1];
  if (task === undefined) return refuse(label, "the Issue has no OMI-NNN Plan Key on the Project");
  if (input.kind !== "claude" && input.kind !== "codex") {
    return refuse(label, `--kind must be claude or codex, got "${input.kind}"`);
  }
  const kind = input.kind;
  if (!WORKER_PROFILES.some((p) => p.tool === kind && p.profile === input.profile)) {
    const known = WORKER_PROFILES.filter((p) => p.tool === kind).map((p) => p.profile);
    return refuse(
      label,
      `no ${kind} worker profile "${input.profile}" (known: ${known.join(", ")})`,
    );
  }
  if (input.prompt.trim() === "") return refuse(label, "the prompt file is empty");
  if (input.resume === null && input.prompt.startsWith(NATIVE_RESUME_HEADER)) {
    return refuse(
      label,
      "findings-only packets require --resume; render a full packet for a fresh worker",
    );
  }

  let level = input.complexity;
  const packet = input.prompt.startsWith(`${NATIVE_RESUME_HEADER}\n\n`)
    ? input.prompt.slice(NATIVE_RESUME_HEADER.length + 2)
    : input.prompt;
  if (packet.startsWith("<!-- omi-quality")) {
    try {
      const raw = /^<!-- omi-quality (.+) -->\r?\n/.exec(packet)?.[1];
      const quality = stepQualitySchema.parse(JSON.parse(raw ?? "") as unknown);
      if (input.resume !== null && ["analyze", "verify", "review"].includes(quality.step)) {
        return refuse(label, "analysis, QA and review require fresh independent workers");
      }
      const decision = resolveQualityPolicy({
        qualityPolicy: quality.policy,
        complexity: input.complexity,
        step: quality.step,
        round: quality.round,
        risks: { security: false, gates: false, data: false },
      });
      if (quality.steps.length > 1 && !decision.combineVerifyReview) {
        return refuse(label, "current policy/complexity requires separate verify/review packets");
      }
      level = decision.effort === "low" || decision.effort === "medium" ? decision.effort : "high";
    } catch {
      return refuse(label, "invalid quality packet metadata");
    }
  }
  const { model, effort } = EFFORT_POLICY[kind][level];
  const spec = { task, profile: input.profile, model, effort, resume: input.resume };
  const launch = wslCommand(
    kind === "claude" ? claudeLaunchPayload(spec) : codexLaunchPayload(spec),
    ctx.target,
    WORKER_TIMEOUT_MS,
  );
  const write: Command = {
    ...wslCommand(
      `mkdir -p $HOME/omi-runs; cat > ${runsPath(task, "prompt.md")}`,
      ctx.target,
      30_000,
    ),
    input: input.prompt,
  };
  const note = `${kind} ${input.profile} ${model} ${effort}${input.resume === null ? "" : ` resume ${input.resume}`}`;

  if (input.dryRun) {
    console.log(`${label}: ${note}`);
    would(label, write);
    would(label, launch);
    return 0;
  }
  await runChecked(ctx.run, write);
  console.log(`${label}: ${note}`);
  const result = await ctx.run(launch);
  const out = result.stdout.trim();
  if (out) console.log(out);
  const exit = /exit=(\d+)/.exec(result.stdout)?.[1];
  if (result.code !== 0 || exit !== "0") {
    const detail = result.stderr.trim();
    console.error(
      `${label}: failed (${exit === undefined ? `no exit status, code ${String(result.code)}` : `worker exit ${exit}`})${detail ? `: ${detail}` : ""}`,
    );
    return 1;
  }
  return 0;
}

const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

/** Prints the final report of the newest worker log of the task; 1 while there is none. */
export async function workerReportCommand(
  ctx: WorkerCtx,
  input: { readonly planKey: string | null; readonly dryRun: boolean },
): Promise<number> {
  const label = `worker-report ${input.planKey ?? "?"}`;
  const task = /^OMI-(\d+)$/.exec(input.planKey ?? "")?.[1];
  if (task === undefined) return refuse(label, "the Issue has no OMI-NNN Plan Key on the Project");
  const list = wslCommand(newestLogCommand(task), ctx.target, 30_000);
  if (input.dryRun) {
    would(label, list);
    return 0;
  }
  const file = (await runChecked(ctx.run, list)).trim();
  if (file === "") return refuse(label, `no worker log omi-${task}-*.jsonl in ~/omi-runs`);
  if (!SAFE_PATH.test(file)) return refuse(label, "the log path has unexpected characters");
  const log = await runChecked(ctx.run, wslCommand(`cat ${file}`, ctx.target, 120_000));
  const name = file.split("/").at(-1) ?? file;
  let report: WorkerReport;
  if (isCodexLog(name)) {
    const last = await ctx.run(
      wslCommand(`cat ${runsPath(task, "codex-last.md")}`, ctx.target, 30_000),
    );
    report = {
      tool: "codex",
      file: name,
      ...parseCodexReport(log, last.code === 0 ? last.stdout : ""),
    };
  } else {
    report = { tool: "claude", file: name, ...parseClaudeReport(log) };
  }
  const validated = report.report === null ? undefined : validateWorkerResult(report.report);
  console.log(
    formatReport({
      ...report,
      report: validated?.success ? validated.data.summary : report.report,
    }),
  );
  if (report.report === null) return 1;
  if (!validated?.success)
    return refuse(label, "worker report does not satisfy the framework step-result-v1 contract");
  return 0;
}

/** Commits a worker's changes (Codex cannot) in the allowed paths only, then prints the SHA. */
export async function commitWorkerCommand(
  ctx: WorkerCtx,
  input: { readonly branch: string; readonly message: string; readonly dryRun: boolean },
): Promise<number> {
  const label = `commit-worker ${input.branch}`;
  assertTaskBranch(input.branch);
  if (input.message.trim() === "") return refuse(label, "the commit message is empty");
  const git = (args: readonly string[]): Command =>
    wslGit(ctx.target)(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args]);
  const current = (await runChecked(ctx.run, git(["rev-parse", "--abbrev-ref", "HEAD"]))).trim();
  const add = git(["add", "-A", "--", ...STAGE_PATHS]);
  const staged = git(["diff", "--cached", "--name-only"]);
  const commit: Command = {
    ...git(["commit", "-F", "-"]),
    input: input.message,
  };
  // The branch is checked before anything is staged; the staged paths are judged after.
  if (current !== input.branch) {
    return refuse(label, `the checkout is on "${current}", not on ${input.branch}`);
  }
  if (input.dryRun) {
    for (const c of [add, staged, commit]) would(label, c);
    return 0;
  }
  await runChecked(ctx.run, add);
  const names = (await runChecked(ctx.run, staged)).split("\n").filter((l) => l.trim() !== "");
  const leftovers = (
    await runChecked(ctx.run, git(["diff", "--name-only", "--", ...STAGE_PATHS]))
  ).trim();
  if (leftovers) return refuse(label, `in-scope unstaged changes remain: ${leftovers}`);
  const untracked = (
    await runChecked(
      ctx.run,
      git(["ls-files", "--others", "--exclude-standard", "--", ...STAGE_PATHS]),
    )
  ).trim();
  if (untracked) return refuse(label, `in-scope untracked changes remain: ${untracked}`);
  const verdict = judgeCommit(input.branch, current, names);
  if (verdict.kind === "refuse") return refuse(label, verdict.reason);
  const made = await ctx.run(commit);
  if (made.code !== 0) {
    console.error(
      `${label}: failed (exit ${String(made.code)}): ${made.stderr.trim() || made.stdout.trim()}`,
    );
    return 1;
  }
  console.log((await runChecked(ctx.run, git(["rev-parse", "HEAD"]))).trim());
  return 0;
}

export interface ReviewCommentInput {
  readonly pr: number;
  readonly prState: string;
  readonly prHead: string;
  readonly issueBody: string;
  readonly body: string;
  readonly dryRun: boolean;
}

/** Validates the VERDICT/AC format against the PR and its Issue, then posts as the Coordinator. */
export async function reviewCommentCommand(
  ctx: Pick<WorkerCtx, "run">,
  input: ReviewCommentInput,
): Promise<number> {
  const label = `review-comment ${String(input.pr)}`;
  if (input.prState !== "OPEN")
    return refuse(label, `PR #${String(input.pr)} is ${input.prState}, not OPEN`);
  const checked = checkReview(input.body, {
    acCount: countAcceptanceCriteria(input.issueBody),
    prHead: input.prHead,
  });
  if (!checked.ok) return refuse(label, checked.reasons.join("; "));
  const login = (
    await runChecked(ctx.run, { file: "gh", args: ["api", "user", "--jq", ".login"] })
  ).trim();
  if (login !== COORDINATOR_LOGIN) {
    return refuse(
      label,
      `gh is logged in as "${login}", not the Coordinator account ${COORDINATOR_LOGIN}`,
    );
  }
  const post: Command = {
    file: "gh",
    args: ["pr", "comment", String(input.pr), "-R", REPO_SLUG, "--body-file", "-"],
    input: input.body,
  };
  if (input.dryRun) {
    console.log(`${label}: ${checked.verdict} on ${checked.head}`);
    would(label, post);
    return 0;
  }
  const out = (await runChecked(ctx.run, post)).trim();
  if (out) console.log(out);
  console.log(`${label}: ok (${checked.verdict} on ${checked.head})`);
  return 0;
}
