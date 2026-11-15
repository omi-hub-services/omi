// Pure part of `flow.ts worker-report` (OMI-077): the worker's final report out of its log.
// Claude: the longest `result` among the result events of the newest jsonl, with the turns,
// permission denials and session id of the last result event. Codex: `omi-NNN-codex-<profile>-<ts>-last.md`
// plus the thread id of the first jsonl line. Lines that are not JSON are skipped.
import "../register-ts-imports.ts";
const { stepResultSchema } = await import("../../src/application/contracts/result.ts");
const { extractStepResult } =
  await import("../../src/application/contracts/step-result-extract.ts");
import type { StepResult } from "../../src/application/contracts/result.ts";
import type { EarlierStepResult } from "../../src/application/services/render-earlier-steps.ts";
import { RUNS_DIR_FROM_HOME } from "./coordinator-settings.ts";

export interface WorkerReport {
  readonly tool: "claude" | "codex";
  readonly file: string;
  readonly report: string | null;
  readonly turns: number | null;
  readonly denials: readonly string[];
  /** Claude session id or Codex thread id, for `dispatch --resume`. */
  readonly resumeId: string | null;
}

type Event = Readonly<Record<string, unknown>>;

function events(jsonl: string): Event[] {
  const out: Event[] = [];
  for (const line of jsonl.split("\n")) {
    try {
      const raw: unknown = JSON.parse(line);
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) out.push(raw as Event);
    } catch {
      // a partial last line of a running worker, or noise
    }
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function denial(raw: unknown): string {
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Event;
  const tool = str(d.tool_name) ?? "unknown";
  const input = (
    typeof d.tool_input === "object" && d.tool_input !== null ? d.tool_input : {}
  ) as Event;
  const subject = str(input.command) ?? str(input.file_path) ?? str(input.path);
  return subject === null ? tool : `${tool}: ${subject.slice(0, 120)}`;
}

export function parseClaudeReport(jsonl: string): Omit<WorkerReport, "tool" | "file"> & {
  readonly sessionId: string | null;
} {
  const all = events(jsonl);
  const results = all.filter((e) => e.type === "result");
  const last = results.at(-1);
  const longest = results
    .map((e) => str(e.result))
    .reduce<string | null>(
      (best, r) => (r !== null && r.length > (best?.length ?? 0) ? r : best),
      null,
    );
  const init = all.find((e) => e.type === "system" && e.subtype === "init");
  const sessionId = str(last?.session_id) ?? str(init?.session_id);
  const denials = Array.isArray(last?.permission_denials)
    ? last.permission_denials.map(denial)
    : [];
  return {
    report: longest,
    turns: typeof last?.num_turns === "number" ? last.num_turns : null,
    denials,
    sessionId,
    resumeId: sessionId,
  };
}

export function parseCodexReport(
  jsonl: string,
  lastMessage: string,
): Omit<WorkerReport, "tool" | "file"> & { readonly threadId: string | null } {
  const all = events(jsonl);
  const first = jsonl.split("\n")[0] ?? "";
  const head = events(first)[0];
  const threadId = head?.type === "thread.started" ? str(head.thread_id) : null;
  return {
    report: lastMessage.trim() === "" ? null : lastMessage,
    turns: all.filter((e) => e.type === "turn.started").length,
    denials: [],
    threadId,
    resumeId: threadId,
  };
}

/** Codex logs are `omi-NNN-codex-<profile>-<ts>.jsonl`; Claude's have no tool in the name. */
export const isCodexLog = (file: string): boolean =>
  /^omi-\d+-codex-/.test(file.split("/").at(-1) ?? file);

/**
 * WSL payload (no `"`, `\`, newline): the newest jsonl of the task. `step` (`verify-1`, or a full
 * packet id) picks the newest log of that step/attempt when parallel workers share the task (OMI-113).
 */
export const newestLogCommand = (task: string, step: string | null = null): string => {
  if (!/^\d{1,6}$/.test(task)) throw new Error(`invalid task "${task}"`);
  if (step !== null && !/^[a-z][a-z0-9]*(-[A-Za-z0-9]+)*$/.test(step)) {
    throw new Error(`invalid step "${step}"`);
  }
  const pick = step === null ? "" : `*-${step}-*`;
  // the "-<step>-" part cannot match a stamp-less legacy log, so those only answer without a step
  return `ls -t $HOME/${RUNS_DIR_FROM_HOME}/omi-${task}-*${pick}.jsonl 2>/dev/null | head -n 1`;
};

export function formatReport(r: WorkerReport): string {
  const idLabel = r.tool === "codex" ? "thread id" : "session id";
  return [
    r.report ?? "(no final report in the log: the worker is still running or stopped early)",
    "",
    `log: ${r.file}`,
    `turns: ${r.turns === null ? "-" : String(r.turns)}`,
    `permission denials: ${String(r.denials.length)}`,
    ...r.denials.map((d) => `  ${d}`),
    `${idLabel}: ${r.resumeId ?? "-"}`,
  ].join("\n");
}

// ── Signed step report on the Issue (OMI-159) ───────────────────────────────
/** What `flow.ts dispatch` recorded about one worker launch; the only source of the signature. */
export interface DispatchMeta {
  readonly task: string;
  readonly tool: "claude" | "codex";
  readonly profile: string;
  readonly model: string;
  readonly effort: string;
  /** Step id, or `verify,review` for a combined packet. */
  readonly step: string;
  readonly round: number;
  readonly head: string | null;
  readonly packet: string;
  /** `["analyze"]` when the Coordinator passed `dispatch --scope-approved`; never read from text. */
  readonly skipped?: readonly string[];
  /** True when the review packet carried the script's security marker; `review-comment` then needs `Security:`. */
  readonly securityReview?: boolean;
}

export interface StepMarker {
  readonly issue: number;
  readonly step: string;
  readonly round: number;
  readonly session: string;
  readonly status: "succeeded" | "failed" | "blocked";
  /** Next step ids (comma-joined), `open-pr` or `waiting-po`. */
  readonly next: string;
}

export const STEP_REPORT_LIMIT = 3000;
/** Pseudo-step id of the Architect run (OMI-165/173): not a workflow step. */
export const ARCHITECT_STEP = "architect";
export const FLOW = 'node "$coordinatorPin/tools/coordinator/flow.ts"';

export const stepMarker = (m: StepMarker): string =>
  `<!-- omi-squad:step-report issue=${String(m.issue)} step=${m.step} round=${String(m.round)} session=${m.session} status=${m.status} next=${m.next} -->`;

const MARKER =
  /<!-- omi-squad:step-report issue=(\d+) step=([a-z][a-z0-9,-]*) round=(\d+) session=([A-Za-z0-9][A-Za-z0-9._-]*) status=(succeeded|failed|blocked) next=([a-z][a-z0-9,-]*) -->/;

export interface ParsedMarker {
  readonly marker: StepMarker;
  /** From the Worker line of the same comment, for a native resume. */
  readonly tool: "claude" | "codex" | null;
  readonly profile: string | null;
  /** From the `**Skipped:**` line of the same comment. */
  readonly skipped: readonly string[];
}

/** Markers of comments by `coordinator` only (a worker's text or another account cannot forge one). */
export function parseStepMarkers(
  comments: readonly { readonly author: string | null; readonly body: string }[],
  coordinator: string,
): ParsedMarker[] {
  return comments.flatMap((c) => {
    if (c.author !== coordinator) return [];
    const m = MARKER.exec(c.body);
    if (m === null) return [];
    // header lines only: the worker's own summary below cannot add a Worker/Skipped line
    const header = c.body.split("\n**Summary:**")[0] ?? "";
    const worker = /^\*\*Worker:\*\* (claude|codex) \/ ([A-Za-z0-9._-]+) · /m.exec(header);
    return [
      {
        marker: {
          issue: Number(m[1]),
          step: m[2] ?? "",
          round: Number(m[3]),
          session: m[4] ?? "",
          status: m[5] as StepMarker["status"],
          next: m[6] ?? "",
        },
        tool: (worker?.[1] as "claude" | "codex" | undefined) ?? null,
        profile: worker?.[2] ?? null,
        skipped:
          /^\*\*Skipped:\*\* ([a-z][a-z0-9,-]*) \(recorded scope decision\)$/m
            .exec(header)?.[1]
            ?.split(",") ?? [],
      },
    ];
  });
}

/**
 * Summary and findings lines of each Coordinator-authored step report, oldest first, one entry per
 * step id of a combined report. A comment whose fixed layout is not intact is skipped.
 */
export function parseStepResults(
  comments: readonly { readonly author: string | null; readonly body: string }[],
  coordinator: string,
): EarlierStepResult[] {
  return comments.flatMap((c) =>
    parseStepMarkers([c], coordinator).flatMap(({ marker }) => {
      const s = c.body.indexOf("\n**Summary:** ");
      const f = c.body.lastIndexOf("\n**Findings:**");
      const n = c.body.lastIndexOf("\n**Next:**");
      if (s < 0 || f < s || n < f) return [];
      const summary = c.body.slice(s + "\n**Summary:** ".length, f).trim();
      const findings = c.body
        .slice(f + "\n**Findings:**".length, n)
        .split("\n")
        .filter((line) => line.startsWith("- "));
      return marker.step.split(",").map((stepId) => ({
        stepId,
        round: marker.round,
        status: marker.status,
        summary,
        findings,
      }));
    }),
  );
}

/**
 * Next step by script, never by the worker: succeeded -> steps whose `needs` are all valid
 * (newest report per step wins; an explicit failure stays failed; a step is skipped only when
 * `skipped` says so), or `open-pr` when none remain; failed -> the same step;
 * blocked -> `waiting-po`.
 */
export function computeNext(
  workflow: {
    readonly steps: readonly {
      readonly id: string;
      readonly needs: readonly string[];
      readonly role?: string;
    }[];
  },
  prior: readonly StepMarker[],
  current: { readonly step: string; readonly status: StepMarker["status"] },
  /** Steps skipped by recorded scope evidence (the Coordinator's dispatch), never inferred. */
  skipped: readonly string[] = [],
): string {
  const ids = workflow.steps.map((s) => s.id);
  if (current.step === ARCHITECT_STEP) {
    // OMI-173: a pseudo-step outside the workflow. It decides, the newest work step resumes with it.
    if (current.status !== "succeeded") return "waiting-po";
    const workIds = workflow.steps.filter((s) => s.role === "developer").map((s) => s.id);
    const work = [...prior]
      .reverse()
      .flatMap((p) => p.step.split(","))
      .find((id) => workIds.includes(id));
    if (work === undefined) throw new Error("no work step is reported on the Issue to resume");
    return work;
  }
  // newest report per step, with its position: a result is only valid while every upstream
  // result is valid and not newer than it (reworked upstream work invalidates what followed)
  const latest = new Map<string, { status: StepMarker["status"]; seq: number }>();
  [...prior, current].forEach((e, seq) => {
    if (e.step === ARCHITECT_STEP) return; // a decision, not a workflow result
    for (const id of e.step.split(",")) {
      if (!ids.includes(id)) throw new Error(`workflow has no step ${id}`);
      latest.set(id, { status: e.status, seq });
    }
  });
  if (current.status === "blocked") return "waiting-po";
  if (current.status === "failed") return current.step;
  const skip = new Set(skipped.filter((id) => ids.includes(id)));
  const needsOf = (id: string): readonly string[] =>
    workflow.steps.find((s) => s.id === id)?.needs ?? [];
  const valid = (id: string): boolean => {
    if (skip.has(id)) return true;
    const own = latest.get(id);
    if (own?.status !== "succeeded") return false;
    return needsOf(id).every((need) => {
      if (skip.has(need)) return true;
      const up = latest.get(need);
      return up !== undefined && up.seq <= own.seq && valid(need);
    });
  };
  const ready = workflow.steps.filter((s) => !valid(s.id) && s.needs.every(valid)).map((s) => s.id);
  return ready.length === 0 ? "open-pr" : ready.join(",");
}

// A worker's text must not be able to forge or close the machine marker.
const defang = (s: string): string => s.replaceAll("<!--", "<!- -").replaceAll("-->", "- ->");
const oneLine = (s: string, max: number): string => {
  const t = defang(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function renderStepReport(input: {
  readonly planKey: string;
  readonly meta: DispatchMeta;
  readonly session: string;
  readonly result: StepResult;
  readonly marker: StepMarker;
}): string {
  const { meta, result, marker } = input;
  const lines = result.findings
    .slice(0, 8)
    .map(
      (f) =>
        `- [${f.severity}] ${f.id}: ${oneLine(f.message, 200)}${f.location === undefined ? "" : ` (${oneLine(f.location, 80)})`}`,
    );
  const nextLine =
    marker.next === "waiting-po"
      ? "Waiting PO: the Coordinator posts `**WAITING-PO:** <reason>`"
      : marker.next === "open-pr"
        ? "no workflow step remains: check, push, open-pr (omi-next step 4)"
        : marker.status === "failed"
          ? `rework after the failed ${marker.next}`
          : marker.step === ARCHITECT_STEP
            ? `resume ${marker.next} with --architect-decision`
            : `dispatch ${marker.next}`;
  const suggestion =
    result.nextAction === undefined
      ? ""
      : ` (worker suggestion: ${oneLine(result.nextAction, 80)})`;
  const skipped = meta.skipped ?? [];
  const head = [
    `**Worker report — ${input.planKey} · step ${meta.step} · round ${String(meta.round)}**`,
    "",
    `**Worker:** ${meta.tool} / ${meta.profile} · ${meta.model} · ${meta.effort} · session ${input.session}`,
    `**Status:** ${result.status} · head \`${meta.head ?? "-"}\``,
    ...(skipped.length === 0
      ? []
      : [`**Skipped:** ${skipped.join(",")} (recorded scope decision)`]),
  ];
  const tail = [
    `**Next:** ${nextLine} — \`${FLOW} next ${String(marker.issue)}\`${suggestion}`,
    "",
    stepMarker(marker),
  ];
  const build = (summary: string, findings: string) =>
    [...head, `**Summary:** ${summary}`, `**Findings:** ${findings}`, ...tail].join("\n");
  // summary and findings share what the fixed lines leave of the cap
  const summary = defang(result.summary).trim();
  const full = lines.length === 0 ? "none" : `\n${lines.join("\n")}`;
  const budget = Math.max(0, STEP_REPORT_LIMIT - build("", "none").length);
  const fLen = lines.length === 0 ? 0 : full.length;
  let sBudget = summary.length;
  let fBudget = fLen;
  if (summary.length + fLen > budget) {
    const half = Math.floor(budget / 2);
    if (summary.length <= half) fBudget = budget - summary.length;
    else if (fLen <= half) sBudget = budget - fLen;
    else {
      sBudget = half;
      fBudget = budget - half;
    }
  }
  const cut = (s: string, max: number) =>
    s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
  let findings = full;
  if (fLen > fBudget) {
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > fBudget - 30) break;
      kept.push(line);
      used += line.length + 1;
    }
    findings = `\n${[...kept, `- … ${String(lines.length - kept.length)} more findings omitted`].join("\n")}`;
  }
  const body = build(cut(summary, sBudget), findings);
  const over = body.length - STEP_REPORT_LIMIT;
  return over <= 0 ? body : build(cut(summary, Math.max(0, sBudget - over)), findings);
}

const INDEPENDENT_ROLES = new Set(["analyst", "qa", "reviewer"]);

/**
 * `pick-profile` / `prompt` / `dispatch` commands for the newest marker (`flow.ts next`). A failed
 * analyze/verify/review step is never resumed (dispatch refuses it): the implementer's work step
 * reworks with the findings; the next report recomputes which quality steps come back.
 */
export function formatNext(
  entry: ParsedMarker,
  workflow: {
    readonly steps: readonly { readonly id: string; readonly role: string }[];
  },
  all: readonly ParsedMarker[] = [entry],
): string[] {
  const { marker, tool, profile } = entry;
  const n = String(marker.issue);
  // a recorded scope-approved skip: prompt keeps the approval ref so analyze stays skipped
  const scope = all.some((e) => e.skipped.length > 0) ? " --scope-approved <ref>" : "";
  const fresh = (step: string, round: number) => [
    `${FLOW} pick-profile ${n} --step ${step} --round ${String(round)} --probe`,
    `${FLOW} prompt ${n} --step ${step} --round ${String(round)}${scope} --notes <notes.md> --out <prompt.md>`,
    `${FLOW} dispatch ${n} --profile <p> --kind <claude|codex> --prompt <prompt.md>`,
  ];
  if (marker.step === ARCHITECT_STEP && marker.status === "succeeded") {
    // the failed work step resumes natively with the findings and the Architect's decision
    const work = [...all].reverse().find((e) => e.marker.step === marker.next);
    const round =
      1 +
      Math.max(0, ...all.filter((e) => e.marker.step === marker.next).map((e) => e.marker.round));
    return [
      `architect round ${String(marker.round)} succeeded: ${marker.next} resumes with the Architect decision (round ${String(round)}).`,
      `${FLOW} prompt ${n} --step ${marker.next} --round ${String(round)} --findings <findings.md> --architect-decision <decision.md> --out <resume.md>`,
      `${FLOW} dispatch ${n} --profile ${work?.profile ?? "<profile of the report>"} --kind ${work?.tool ?? "<claude|codex of the report>"} --resume ${work?.marker.session ?? "<session of the report>"} --prompt <resume.md>`,
    ];
  }
  if (marker.step === ARCHITECT_STEP || marker.status === "blocked") {
    return [
      `Waiting PO after ${marker.step} round ${String(marker.round)}: the Coordinator posts a "**WAITING-PO:** <reason>" comment and asks the PO. No dispatch.`,
    ];
  }
  if (marker.status === "failed") {
    const round = marker.round + 1;
    const roleOf = (id: string) => workflow.steps.find((s) => s.id === id)?.role ?? "";
    if (!marker.step.split(",").some((id) => INDEPENDENT_ROLES.has(roleOf(id)))) {
      return [
        `${marker.step} round ${String(marker.round)} failed: resume the same worker with the findings (round ${String(round)}).`,
        `${FLOW} prompt ${n} --step ${marker.step} --round ${String(round)} --findings <findings.md> --out <resume.md>`,
        `${FLOW} dispatch ${n} --profile ${profile ?? "<profile of the report>"} --kind ${tool ?? "<claude|codex of the report>"} --resume ${marker.session} --prompt <resume.md>`,
      ];
    }
    const devIds = workflow.steps.filter((s) => s.role === "developer").map((s) => s.id);
    const dev = [...all]
      .reverse()
      .find((e) => e.marker.step.split(",").some((id) => devIds.includes(id)));
    if (dev === undefined) {
      return [
        `${marker.step} round ${String(marker.round)} failed. It is an independent step and is never resumed; no implementer report is recorded on the Issue, so a fresh packet runs it again (start the work step with a full packet if the findings need code changes).`,
        ...fresh(marker.step, round),
      ];
    }
    // The rework invalidates the quality results that followed it; the report after the rework
    // makes the script compute which steps come back (never chained here).
    return [
      `${marker.step} round ${String(marker.round)} failed. It is an independent step and is never resumed: the implementer's work step reworks with these findings first.`,
      `${FLOW} prompt ${n} --step ${dev.marker.step} --round ${String(dev.marker.round + 1)} --findings <findings.md> --out <resume.md>`,
      `${FLOW} dispatch ${n} --profile ${dev.profile ?? "<profile of the report>"} --kind ${dev.tool ?? "<claude|codex of the report>"} --resume ${dev.marker.session} --prompt <resume.md>`,
      `after the rework is committed and checked: ${FLOW} worker-report ${n} --post, then ${FLOW} next ${n}`,
    ];
  }
  if (marker.next === "open-pr") {
    return [
      `${marker.step} round ${String(marker.round)} succeeded and no workflow step remains:`,
      `${FLOW} check <branch> --head <sha>, then push, then open-pr ${n} <branch> --title "OMI-NNN: …" --body-file <f> (omi-next step 4)`,
    ];
  }
  // the state is on the Issue: a step that ran before comes back as its highest round + 1
  const nextRound = (step: string) =>
    1 +
    Math.max(
      0,
      ...all.filter((e) => e.marker.step.split(",").includes(step)).map((e) => e.marker.round),
    );
  return [
    `${marker.step} round ${String(marker.round)} succeeded; next: ${marker.next}`,
    ...marker.next.split(",").flatMap((step) => fresh(step, nextRound(step))),
  ];
}

/** Repository reports use the same v1 document as all four runtime output-contract aliases. */
export function validateWorkerResult(report: string) {
  const extracted = extractStepResult(report);
  return stepResultSchema.safeParse(extracted.ok ? extracted.value : undefined);
}
