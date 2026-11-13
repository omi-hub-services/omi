// Pure part of `flow.ts worker-report` (OMI-077): the worker's final report out of its log.
// Claude: the longest `result` among the result events of the newest jsonl, with the turns,
// permission denials and session id of the last result event. Codex: `omi-NNN-codex-last.md`
// plus the thread id of the first jsonl line. Lines that are not JSON are skipped.
import "../register-ts-imports.ts";
const { stepResultSchema } = await import("../../src/application/contracts/result.ts");
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

/** WSL payload (no `"`, `\`, newline): the newest jsonl of the task. */
export const newestLogCommand = (task: string): string => {
  if (!/^\d{1,6}$/.test(task)) throw new Error(`invalid task "${task}"`);
  return `ls -t $HOME/${RUNS_DIR_FROM_HOME}/omi-${task}-*.jsonl 2>/dev/null | head -n 1`;
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

/** Repository reports use the same v1 document as all four runtime output-contract aliases. */
export function validateWorkerResult(report: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(report);
  } catch {
    raw = undefined;
  }
  return stepResultSchema.safeParse(raw);
}
