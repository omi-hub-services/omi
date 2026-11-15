// Pure part of `flow.ts worker-report` (OMI-077): the worker's final report out of its log.
// Claude: the longest `result` among the result events of the newest jsonl, with the turns,
// permission denials and session id of the last result event. Codex: `omi-NNN-codex-<profile>-<ts>-last.md`
// plus the thread id of the first jsonl line. Lines that are not JSON are skipped.
import "../register-ts-imports.ts";
const { stepResultSchema } = await import("../../src/application/contracts/result.ts");
const { extractStepResult } =
  await import("../../src/application/contracts/step-result-extract.ts");
import type { StepResult } from "../../src/application/contracts/result.ts";
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
    const worker = /^\*\*Worker:\*\* (claude|codex) \/ ([A-Za-z0-9._-]+) · /m.exec(c.body);
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
      },
    ];
  });
}

/**
 * Next step by script, never by the worker: succeeded -> steps whose `needs` are all succeeded
 * (newest marker per step wins), or `open-pr` when none remain; failed -> the same step;
 * blocked -> `waiting-po`.
 */
export function computeNext(
  workflow: {
    readonly steps: readonly { readonly id: string; readonly needs: readonly string[] }[];
  },
  prior: readonly StepMarker[],
  current: { readonly step: string; readonly status: StepMarker["status"] },
): string {
  const ids = workflow.steps.map((s) => s.id);
  const state = new Map<string, StepMarker["status"]>();
  for (const e of [...prior, current]) {
    for (const id of e.step.split(",")) {
      if (!ids.includes(id)) throw new Error(`workflow has no step ${id}`);
      state.set(id, e.status);
    }
  }
  if (current.status === "blocked") return "waiting-po";
  if (current.status === "failed") return current.step;
  const satisfied = new Set([...state].filter(([, s]) => s === "succeeded").map(([id]) => id));
  // a step that a succeeded step needs is satisfied even without its own report (analyze skipped
  // by a recorded scope decision)
  const needsOf = (id: string): readonly string[] =>
    workflow.steps.find((s) => s.id === id)?.needs ?? [];
  for (const id of satisfied) for (const need of needsOf(id)) satisfied.add(need);
  const done = (id: string) => satisfied.has(id);
  const ready = workflow.steps.filter((s) => !done(s.id) && s.needs.every(done)).map((s) => s.id);
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
  const findings =
    result.findings.length === 0
      ? "none"
      : `\n${result.findings
          .slice(0, 8)
          .map(
            (f) =>
              `- [${f.severity}] ${f.id}: ${oneLine(f.message, 200)}${f.location === undefined ? "" : ` (${oneLine(f.location, 80)})`}`,
          )
          .join("\n")}`;
  const nextLine =
    marker.next === "waiting-po"
      ? "Waiting PO: the Coordinator posts `**WAITING-PO:** <reason>`"
      : marker.next === "open-pr"
        ? "no workflow step remains: check, push, open-pr (omi-next step 4)"
        : marker.status === "failed"
          ? `resume ${marker.next} with the findings`
          : `dispatch ${marker.next}`;
  const suggestion =
    result.nextAction === undefined
      ? ""
      : ` (worker suggestion: ${oneLine(result.nextAction, 80)})`;
  const head = [
    `**Worker report — ${input.planKey} · step ${meta.step} · round ${String(meta.round)}**`,
    "",
    `**Worker:** ${meta.tool} / ${meta.profile} · ${meta.model} · ${meta.effort} · session ${input.session}`,
    `**Status:** ${result.status} · head \`${meta.head ?? "-"}\``,
  ];
  const tail = [
    `**Findings:** ${findings}`,
    `**Next:** ${nextLine} — \`${FLOW} next ${String(marker.issue)}\`${suggestion}`,
    "",
    stepMarker(marker),
  ];
  const build = (summary: string) => [...head, `**Summary:** ${summary}`, ...tail].join("\n");
  const summary = defang(result.summary).trim();
  const over = build(summary).length - STEP_REPORT_LIMIT;
  return over <= 0 ? build(summary) : build(`${summary.slice(0, summary.length - over - 1)}…`);
}

/** `pick-profile` / `prompt` / `dispatch` commands for the newest marker (`flow.ts next`). */
export function formatNext(entry: ParsedMarker): string[] {
  const { marker, tool, profile } = entry;
  const n = String(marker.issue);
  if (marker.status === "blocked") {
    return [
      `Waiting PO after ${marker.step} round ${String(marker.round)}: the Coordinator posts a "**WAITING-PO:** <reason>" comment and asks the PO. No dispatch.`,
    ];
  }
  if (marker.status === "failed") {
    const round = String(marker.round + 1);
    return [
      `${marker.step} round ${String(marker.round)} failed: resume the same worker with the findings (round ${round}).`,
      `${FLOW} prompt ${n} --step ${marker.step} --round ${round} --findings <findings.md> --out <resume.md>`,
      `${FLOW} dispatch ${n} --profile ${profile ?? "<profile of the report>"} --kind ${tool ?? "<claude|codex of the report>"} --resume ${marker.session} --prompt <resume.md>`,
    ];
  }
  if (marker.next === "open-pr") {
    return [
      `${marker.step} round ${String(marker.round)} succeeded and no workflow step remains:`,
      `${FLOW} check <branch> --head <sha>, then push, then open-pr ${n} <branch> --title "OMI-NNN: …" --body-file <f> (omi-next step 4)`,
    ];
  }
  return [
    `${marker.step} round ${String(marker.round)} succeeded; next: ${marker.next}`,
    ...marker.next
      .split(",")
      .flatMap((step) => [
        `${FLOW} pick-profile ${n} --step ${step} --round 1 --probe`,
        `${FLOW} prompt ${n} --step ${step} --round 1 --notes <notes.md> --out <prompt.md>`,
        `${FLOW} dispatch ${n} --profile <p> --kind <claude|codex> --prompt <prompt.md>`,
      ]),
  ];
}

/** Repository reports use the same v1 document as all four runtime output-contract aliases. */
export function validateWorkerResult(report: string) {
  const extracted = extractStepResult(report);
  return stepResultSchema.safeParse(extracted.ok ? extracted.value : undefined);
}
