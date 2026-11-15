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
  dispatchStamp,
  promptFile,
  runsPath,
} from "./worker-launch.ts";
import {
  computeNext,
  formatNext,
  formatReport,
  validateWorkerResult,
  isCodexLog,
  newestLogCommand,
  parseClaudeReport,
  parseCodexReport,
  parseStepMarkers,
  renderStepReport,
  type DispatchMeta,
  type StepMarker,
  type WorkerReport,
} from "./worker-report.ts";
import type { Workflow } from "../../src/application/contracts/workflow.ts";
import type { StepResult } from "../../src/application/contracts/result.ts";
import {
  asNumber,
  asObject,
  asString,
  optString,
  parseJson,
  type AuthoredComment,
} from "./json-shape.ts";
const { assertCredentialFree } =
  await import("../../src/application/contracts/credential-input.ts");

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
  /** `--scope-approved <ref>` from the Coordinator: analyze is recorded as skipped. */
  readonly scopeApproved?: string | null;
  readonly dryRun: boolean;
}

/**
 * Writes the rendered prompt unchanged to WSL
 * `~/omi-runs/omi-NNN-prompt-<step>-<attempt>.md`, then runs the worker in the foreground; the Coordinator's
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
  let packetBase = "adhoc"; // a packet without quality metadata has no step or attempt to name it
  let reported: { readonly step: string; readonly round: number } | null = null;
  const packet = input.prompt.startsWith(`${NATIVE_RESUME_HEADER}\n\n`)
    ? input.prompt.slice(NATIVE_RESUME_HEADER.length + 2)
    : input.prompt;
  if (packet.startsWith("<!-- omi-quality")) {
    try {
      const raw = /^<!-- omi-quality (.+) -->\r?\n/.exec(packet)?.[1];
      const quality = stepQualitySchema.parse(JSON.parse(raw ?? "") as unknown);
      packetBase = `${quality.step}-${String(quality.round)}`;
      reported = { step: quality.steps.join(","), round: quality.round };
      if (
        input.resume !== null &&
        ["analyze", "architect", "verify", "review"].includes(quality.step)
      ) {
        return refuse(
          label,
          "analysis, Architect, QA and review require fresh independent workers",
        );
      }
      const decision = resolveQualityPolicy({
        qualityPolicy: quality.policy,
        complexity: input.complexity,
        step: quality.step,
        round: quality.round,
        risks: { security: false, gates: false, data: false },
      });

      level = decision.effort === "low" || decision.effort === "medium" ? decision.effort : "high";
    } catch {
      return refuse(label, "invalid quality packet metadata");
    }
  }
  // the stamp makes the path unique per dispatch, so even the same step and round (or `adhoc`)
  // never reuses the file of a worker that may still be running
  const packetId = `${packetBase}-${dispatchStamp()}`;
  const { model, effort } = EFFORT_POLICY[kind][level];
  const spec = {
    task,
    profile: input.profile,
    model,
    effort,
    resume: input.resume,
    packet: packetId,
  };
  const launch = wslCommand(
    kind === "claude" ? claudeLaunchPayload(spec) : codexLaunchPayload(spec),
    ctx.target,
    WORKER_TIMEOUT_MS,
  );
  const file = runsPath(task, promptFile(input.resume, packetId));
  const write: Command = {
    ...wslCommand(
      // atomic: a reader never sees a half-written packet
      `mkdir -p $HOME/omi-runs; cat > ${file}.tmp && mv -f ${file}.tmp ${file}`,
      ctx.target,
      30_000,
    ),
    input: input.prompt,
  };
  const note = `${kind} ${input.profile} ${model} ${effort}${input.resume === null ? "" : ` resume ${input.resume}`}`;
  // The signature of the step report (OMI-159): recorded here, never read from the worker's claims.
  const metaFile = runsPath(task, `meta-${packetId}.json`);
  const head = input.dryRun
    ? null
    : await ctx
        .run(wslGit(ctx.target)(["rev-parse", "HEAD"]))
        .then((r) =>
          r.code === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim()) ? r.stdout.trim() : null,
        );
  const meta: DispatchMeta | null =
    reported === null
      ? null
      : {
          task,
          tool: kind,
          profile: input.profile,
          model,
          effort,
          ...reported,
          head,
          packet: packetId,
          skipped: input.scopeApproved == null ? [] : ["analyze"],
        };
  const writeMeta: Command | null =
    meta === null
      ? null
      : {
          ...wslCommand(
            `mkdir -p $HOME/omi-runs; cat > ${metaFile}.tmp && mv -f ${metaFile}.tmp ${metaFile}`,
            ctx.target,
            30_000,
          ),
          input: JSON.stringify(meta),
        };

  if (input.dryRun) {
    console.log(`${label}: ${note}`);
    would(label, write);
    if (writeMeta !== null) would(label, writeMeta);
    would(label, launch);
    return 0;
  }
  await runChecked(ctx.run, write);
  if (writeMeta !== null) await runChecked(ctx.run, writeMeta);
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
  input: {
    readonly planKey: string | null;
    readonly dryRun: boolean;
    readonly step?: string | null;
    /** `--post`: sign the report from the dispatch metadata and post it on the Issue. */
    readonly post?: {
      readonly number: number;
      readonly comments: readonly AuthoredComment[];
      readonly workflow: Pick<Workflow, "steps">;
    };
  },
): Promise<number> {
  const label = `worker-report ${input.planKey ?? "?"}`;
  const task = /^OMI-(\d+)$/.exec(input.planKey ?? "")?.[1];
  if (task === undefined) return refuse(label, "the Issue has no OMI-NNN Plan Key on the Project");
  let listPayload: string;
  try {
    listPayload = newestLogCommand(task, input.step ?? null);
  } catch (error) {
    return refuse(label, error instanceof Error ? error.message : String(error));
  }
  const list = wslCommand(listPayload, ctx.target, 30_000);
  if (input.dryRun) {
    would(label, list);
    return 0;
  }
  const file = (await runChecked(ctx.run, list)).trim();
  if (file === "") {
    return refuse(
      label,
      `no worker log omi-${task}-*${input.step ? `-${input.step}-*` : ""}.jsonl in ~/omi-runs`,
    );
  }
  if (!SAFE_PATH.test(file)) return refuse(label, "the log path has unexpected characters");
  const log = await runChecked(ctx.run, wslCommand(`cat ${file}`, ctx.target, 120_000));
  const name = file.split("/").at(-1) ?? file;
  let report: WorkerReport;
  if (isCodexLog(name)) {
    // the last message of this very log (OMI-111), not of another worker of the task
    const last = await ctx.run(
      wslCommand(`cat ${file.replace(/\.jsonl$/, "-last.md")}`, ctx.target, 30_000),
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
      report: validated?.success ? JSON.stringify(validated.data, null, 2) : report.report,
    }),
  );
  if (report.report === null) return 1;
  if (!validated?.success) {
    const issue = validated?.error.issues[0];
    const detail = issue ? ` (${issue.path.join(".") || "<root>"}: ${issue.message})` : "";
    return refuse(
      label,
      `worker report does not satisfy the framework step-result-v1 contract${detail}`,
    );
  }
  if (input.post !== undefined) {
    return postStepReport(ctx, label, {
      task,
      planKey: input.planKey ?? "",
      logName: name,
      session: report.resumeId,
      result: validated.data,
      ...input.post,
    });
  }
  return validated.data.status === "succeeded" ? 0 : 1;
}

const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function coordinatorLoginRefusal(ctx: Pick<WorkerCtx, "run">): Promise<string | null> {
  const login = (
    await runChecked(ctx.run, { file: "gh", args: ["api", "user", "--jq", ".login"] })
  ).trim();
  return login === COORDINATOR_LOGIN
    ? null
    : `gh is logged in as "${login}", not the Coordinator account ${COORDINATOR_LOGIN}`;
}

/** Reads the dispatch metadata of the log's packet; null when it is missing or malformed. */
async function readDispatchMeta(
  ctx: WorkerCtx,
  task: string,
  logName: string,
): Promise<DispatchMeta | null> {
  const packet = /-\d{8}-\d{6}-([a-z][a-z0-9]*-\d+-[a-z0-9]+)\.jsonl$/.exec(logName)?.[1];
  if (packet === undefined) return null;
  const read = await ctx.run(
    wslCommand(`cat ${runsPath(task, `meta-${packet}.json`)}`, ctx.target, 30_000),
  );
  if (read.code !== 0) return null;
  try {
    const m = asObject(parseJson(read.stdout, "dispatch metadata"), "meta");
    const tool = asString(m.tool, "tool");
    const head = optString(m.head, "head");
    const meta = {
      task: asString(m.task, "task"),
      tool: tool as DispatchMeta["tool"],
      profile: asString(m.profile, "profile"),
      model: asString(m.model, "model"),
      effort: asString(m.effort, "effort"),
      step: asString(m.step, "step"),
      round: asNumber(m.round, "round"),
      head,
      packet: asString(m.packet, "packet"),
      skipped: Array.isArray(m.skipped) ? (m.skipped as unknown[]) : [],
    };
    const ok =
      (tool === "claude" || tool === "codex") &&
      meta.task === task &&
      meta.packet === packet &&
      [meta.profile, meta.model, meta.effort].every((v) => WORD.test(v)) &&
      /^[a-z][a-z0-9,-]*$/.test(meta.step) &&
      Number.isSafeInteger(meta.round) &&
      meta.round >= 1 &&
      (head === null || /^[0-9a-f]{40}$/.test(head)) &&
      (meta.skipped.length === 0 || (meta.skipped.length === 1 && meta.skipped[0] === "analyze"));
    return ok ? { ...meta, skipped: meta.skipped as string[] } : null;
  } catch {
    return null;
  }
}

/**
 * Signs the worker's step result with the Coordinator's dispatch metadata and posts it on the
 * Issue (OMI-159). The same step/round/session is posted once.
 */
async function postStepReport(
  ctx: WorkerCtx,
  label: string,
  input: {
    readonly task: string;
    readonly planKey: string;
    readonly logName: string;
    readonly session: string | null;
    readonly result: StepResult;
    readonly number: number;
    readonly comments: readonly AuthoredComment[];
    readonly workflow: Pick<Workflow, "steps">;
  },
): Promise<number> {
  const meta = await readDispatchMeta(ctx, input.task, input.logName);
  if (meta === null) {
    return refuse(label, `no dispatch metadata for ${input.logName} (dispatched before OMI-159?)`);
  }
  if (input.session === null || !WORD.test(input.session)) {
    return refuse(label, "the worker log has no usable session/thread id");
  }
  const parsed = parseStepMarkers(input.comments, COORDINATOR_LOGIN);
  const prior = parsed.map((p) => p.marker);
  // only an `analyze` step without needs can be skipped by a recorded scope decision
  const skippable = input.workflow.steps.some((s) => s.id === "analyze" && s.needs.length === 0);
  const skipped = skippable
    ? [...new Set([...parsed.flatMap((p) => p.skipped), ...(meta.skipped ?? [])])].filter(
        (id) => id === "analyze",
      )
    : [];
  if (
    prior.some((p) => p.step === meta.step && p.round === meta.round && p.session === input.session)
  ) {
    console.log(`${label}: done: ${meta.step} round ${String(meta.round)} already reported`);
    return 0;
  }
  let marker: StepMarker;
  try {
    marker = {
      issue: input.number,
      step: meta.step,
      round: meta.round,
      session: input.session,
      status: input.result.status,
      next: computeNext(
        input.workflow,
        prior,
        { step: meta.step, status: input.result.status },
        skipped,
      ),
    };
  } catch (error) {
    return refuse(label, error instanceof Error ? error.message : String(error));
  }
  // The guard sees everything the worker wrote, not only what survives the body cap.
  try {
    assertCredentialFree([
      input.result.summary,
      ...(input.result.nextAction === undefined ? [] : [input.result.nextAction]),
      ...input.result.findings.flatMap((f) => [
        f.id,
        f.message,
        ...(f.location ? [f.location] : []),
      ]),
    ]);
  } catch {
    return refuse(label, "the report contains a credential-like value; nothing was posted");
  }
  const body = renderStepReport({
    planKey: input.planKey,
    meta,
    session: input.session,
    result: input.result,
    marker,
  });
  try {
    assertCredentialFree(body);
  } catch {
    return refuse(label, "the report contains a credential-like value; nothing was posted");
  }
  const login = await coordinatorLoginRefusal(ctx);
  if (login !== null) return refuse(label, login);
  const post: Command = {
    file: "gh",
    args: ["issue", "comment", String(input.number), "-R", REPO_SLUG, "--body-file", "-"],
    input: body,
  };
  const out = (await runChecked(ctx.run, post)).trim();
  if (out) console.log(out);
  console.log(
    `${label}: ok (${meta.step} round ${String(meta.round)} ${marker.status}, next ${marker.next})`,
  );
  return 0;
}

/** Read-only: the next step and its exact commands, from the newest Coordinator step marker. */
export function nextCommand(input: {
  readonly number: number;
  readonly comments: readonly AuthoredComment[];
  readonly workflow: Pick<Workflow, "steps">;
}): number {
  const all = parseStepMarkers(input.comments, COORDINATOR_LOGIN);
  const newest = all.at(-1);
  if (newest === undefined) {
    console.error(`next ${String(input.number)}: refused: no step report on the Issue yet`);
    return 1;
  }
  console.log(formatNext(newest, input.workflow, all).join("\n"));
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
  const leftovers = (await runChecked(ctx.run, git(["diff", "--name-only", "--"]))).trim();
  if (leftovers) return refuse(label, `unstaged changes remain: ${leftovers}`);
  const untracked = (
    await runChecked(ctx.run, git(["ls-files", "--others", "--exclude-standard", "--"]))
  ).trim();
  if (untracked) return refuse(label, `untracked changes remain: ${untracked}`);
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
  readonly checkStatus: "pass" | "fail" | "pending" | "none";
  readonly baseSha?: string | null | undefined;
  readonly regressionEvidence?: unknown;
  readonly issueBody: string;
  readonly workflow?: string | null;
  /** The review packet's security risk (`securityReviewRisk`); the review then needs `Security:`. */
  readonly securityRisk?: boolean;
  readonly body: string;
  readonly dryRun: boolean;
}

/** Validates the VERDICT/AC format against the PR and its Issue, then posts as the Coordinator. */
export async function reviewCommentCommand(
  ctx: Pick<WorkerCtx, "run">,
  input: ReviewCommentInput,
): Promise<number> {
  const label = `review-comment ${String(input.pr)}`;
  if (input.prState !== "OPEN" && !(input.workflow === "release" && input.prState === "MERGED"))
    return refuse(
      label,
      `PR #${String(input.pr)} is ${input.prState}; needs OPEN or a MERGED release PR`,
    );
  const checked = checkReview(input.body, {
    acCount: countAcceptanceCriteria(input.issueBody),
    prHead: input.prHead,
    workflow: input.workflow,
    baseSha: input.baseSha,
    regressionEvidence: input.regressionEvidence,
    securityRisk: input.securityRisk,
  });
  if (!checked.ok) return refuse(label, checked.reasons.join("; "));
  if (checked.verdict === "PASS" && input.checkStatus !== "pass")
    return refuse(label, "required checks must be green on the exact reviewed PR head");
  const login = await coordinatorLoginRefusal(ctx);
  if (login !== null) return refuse(label, login);
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
