// WSL worker probe: one bash payload lists processes and the newest stream-json log in
// ~/omi-runs; parsing is pure. Only event metadata (type, subtype, ids, counters) is read from
// the latest log. Per-process summaries retain only a bounded last action, never full argv/logs.
import { RUNS_DIR_FROM_HOME, type WslTarget } from "./coordinator-settings.ts";
import { runChecked, WSL_NODE_ENV, wslCommand, type Runner } from "./process-runner.ts";

const MAX_LINE = 65536;

/** Payload for `bash -lc`; free of `"` and `\` so it survives Windows command-line quoting. */
export const WORKER_PROBE = [
  "echo @@ps",
  "ps -eo pid=,etimes=,ppid=,args=",
  "echo @@log",
  `f=$(ls -t $HOME/${RUNS_DIR_FROM_HOME}/*.jsonl 2>/dev/null | head -n 1)`,
  // `[ -n $f ]` would be true for an empty $f without quotes, hence the length test.
  `if [ $` +
    `{#f} -gt 0 ]; then stat -c '%n|%Y|%s' $f; echo @@now; date +%s; echo @@first; head -n 1 $f | head -c ${String(MAX_LINE)}; echo; echo @@last; tail -n 1 $f | head -c ${String(MAX_LINE)}; echo; fi`,
].join("; ");

export interface WorkerProcess {
  readonly pid: number;
  readonly tool: "claude" | "codex";
  readonly headless: boolean;
  readonly elapsedSeconds: number;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly task?: string | null;
  readonly profile?: string | null;
  readonly log?: WorkerLogSummary | null;
}

export interface WorkerLogSummary {
  readonly numTurns: number;
  readonly lastAction: string | null;
  readonly finished: boolean;
  readonly isError: boolean;
  readonly limited: boolean;
}

export interface RunLog {
  readonly file: string;
  readonly sizeBytes: number;
  readonly ageSeconds: number;
  readonly sessionId: string | null;
  readonly model: string | null;
  /** Last event type/subtype; `result` means the run finished. */
  readonly lastEvent: string | null;
  readonly finished: boolean;
  readonly isError: boolean | null;
  readonly numTurns: number | null;
}

export interface WorkerReport {
  readonly processes: readonly WorkerProcess[];
  readonly latestLog: RunLog | null;
}

const basename = (p: string) => p.split("/").at(-1) ?? p;

function workerTool(args: readonly string[]): "claude" | "codex" | null {
  const first = basename(args[0] ?? "");
  const candidate = first === "node" || first === "nodejs" ? basename(args[1] ?? "") : first;
  return candidate === "claude" || candidate === "codex" ? candidate : null;
}

/** Worker argv (prompts, paths, flags) is read only to classify the process, never kept. */
export function parseProcesses(psOutput: string): WorkerProcess[] {
  const out: WorkerProcess[] = [];
  const parents = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const parent = /^(\d+)\s+(.+)$/.exec(m[3]);
    const command = parent?.[2] ?? m[3];
    if (parent?.[1]) parents.set(Number(m[1]), Number(parent[1]));
    const args = command.trim().split(/\s+/);
    const tool = workerTool(args);
    if (!tool) continue;
    out.push({
      pid: Number(m[1]),
      tool,
      headless: args.includes("-p") || args.includes("--print") || args.includes("exec"),
      elapsedSeconds: Number(m[2]),
      ...parseWorkerArgs(command, tool),
    });
  }
  return out.filter((p) => {
    if (p.tool !== "codex") return true;
    const visited = new Set<number>([p.pid]);
    let parent = parents.get(p.pid);
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      if (out.some((other) => other.pid === parent && other.tool === p.tool)) return false;
      parent = parents.get(parent);
    }
    return true;
  });
}

/** ps flattens argv: accept quoted flag values but never retain prompts or full argv. */
export function parseWorkerArgs(command: string, tool: "claude" | "codex") {
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  const clean = (s: string) => s.replace(/^["']|["']$/g, "");
  let model: string | null = null;
  let effort: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = clean(tokens[i] ?? "");
    const next = clean(tokens[i + 1] ?? "");
    if (token === "--") break;
    if (token === "--model" || (tool === "codex" && token === "-m")) model = next || null;
    if (token.startsWith("--model=")) model = token.slice(8) || null;
    if (tool === "claude" && token === "--effort") effort = next || null;
    if (tool === "claude" && token.startsWith("--effort=")) effort = token.slice(9) || null;
    if (tool === "codex" && (token === "-c" || token === "--config")) {
      const match = /^model_reasoning_effort=["']?([a-z]+)["']?$/.exec(next);
      if (match?.[1]) effort = match[1];
    }
  }
  // Values are display metadata, not arbitrary arguments or terminal control sequences.
  const safe = (s: string | null) => (s && /^[a-zA-Z0-9_.:+-]{1,100}$/.test(s) ? s : null);
  return { model: safe(model), effort: safe(effort) };
}

export function workerLogIdentity(path: string, tool: "claude" | "codex") {
  const match = /^omi-(\d+)-(.+)-\d{8}-\d{6}\.jsonl$/.exec(basename(path));
  let profile = match?.[2] ?? null;
  // Current Codex dispatch names also include the tool before the profile.
  if (profile?.startsWith(`${tool}-`)) profile = profile.slice(tool.length + 1);
  return { task: match?.[1] ? `OMI-${match[1]}` : null, profile };
}

/** Self-contained reducer also sent to WSL as JavaScript via stdin (Node strips TS).
 * Streaming the log obtains exact counts while retaining only its last action, not history.
 * Claude counts assistant messages; Codex counts provider turn.started events.
 */
export function advanceWorkerLog(state: WorkerLogSummary, line: string): WorkerLogSummary {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return state;
  }
  const obj = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const e = obj(raw);
  if (!e) return state;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const oneLine = (v: string) =>
    v
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  let { numTurns, lastAction, finished, isError, limited } = state;
  if (e.type === "assistant") {
    numTurns++;
    const content = obj(e.message)?.content;
    if (Array.isArray(content))
      for (const block of content) {
        const b = obj(block);
        if (b?.type === "tool_use") {
          const input = obj(b.input);
          lastAction = oneLine(
            `${text(b.name)} ${text(input?.command) || text(input?.file_path) || text(input?.pattern)}`,
          );
        } else if (b?.type === "text" && text(b.text).trim()) lastAction = oneLine(text(b.text));
      }
    if (e.error) isError = true;
  }
  if (e.type === "turn.started") {
    numTurns++;
    finished = false;
  }
  if (e.type === "item.started" || e.type === "item.updated" || e.type === "item.completed") {
    const item = obj(e.item);
    if (item?.type === "command_execution") lastAction = oneLine(`command ${text(item.command)}`);
    else if (item?.type === "agent_message" && text(item.text).trim())
      lastAction = oneLine(text(item.text));
    else if (item?.type === "mcp_tool_call")
      lastAction = oneLine(`${text(item.server)} ${text(item.tool)}`);
    else if (item?.type === "file_change") lastAction = "file_change";
    if (item?.type === "error") {
      isError = true;
      lastAction = oneLine(text(item.message));
    }
  }
  if (e.type === "result") {
    finished = true;
    isError = e.is_error === true;
    if (typeof e.num_turns === "number" && Number.isSafeInteger(e.num_turns) && e.num_turns >= 0)
      numTurns = e.num_turns;
  }
  if (e.type === "turn.completed") finished = true;
  if (e.type === "turn.failed" || e.type === "error") {
    isError = true;
    finished = e.type === "turn.failed";
    lastAction = oneLine(text(obj(e.error)?.message) || text(e.message)) || lastAction;
  }
  if (e.type === "rate_limit_event") limited = obj(e.rate_limit_info)?.status === "rejected";
  if (isError && lastAction && /rate.?limit|quota|usage limit/i.test(lastAction)) limited = true;
  return { numTurns, lastAction, finished, isError, limited };
}

export function parseWorkerTail(tail: string): WorkerLogSummary {
  return tail.split("\n").reduce(advanceWorkerLog, {
    numTurns: 0,
    lastAction: null,
    finished: false,
    isError: false,
    limited: false,
  });
}

/** Resolve fd 1 rather than guessing which task a process belongs to. Only regular jsonl
 * files are read (never pipes/devices). Disappearing processes/logs degrade independently.
 */
function processLogCollector(): string {
  return `
import { createReadStream } from 'node:fs';
import { readlink, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const advanceWorkerLog = ${advanceWorkerLog.toString()};
for (const pid of process.argv.slice(2)) {
  try {
    const path = await readlink('/proc/' + pid + '/fd/1');
    if (!path.endsWith('.jsonl') || !(await stat(path)).isFile()) continue;
    const stream = createReadStream(path, { encoding: 'utf8' });
    let summary = { numTurns: 0, lastAction: null, finished: false, isError: false, limited: false };
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    stream.on('error', () => lines.close());
    for await (const line of lines) summary = advanceWorkerLog(summary, line);
    console.log(JSON.stringify({ pid: Number(pid), path, summary }));
  } catch {}
}
`;
}

function attachProcessLogs(report: WorkerReport, stdout: string): WorkerReport {
  const logs = new Map<number, { path: string; log: WorkerLogSummary }>();
  for (const line of stdout.split("\n")) {
    const row = eventOf(line);
    const summary = row?.summary;
    if (
      typeof row?.pid !== "number" ||
      typeof row.path !== "string" ||
      typeof summary !== "object" ||
      summary === null
    )
      continue;
    const s = summary as Record<string, unknown>;
    if (
      typeof s.numTurns !== "number" ||
      !Number.isSafeInteger(s.numTurns) ||
      s.numTurns < 0 ||
      !(s.lastAction === null || typeof s.lastAction === "string") ||
      typeof s.finished !== "boolean" ||
      typeof s.isError !== "boolean" ||
      typeof s.limited !== "boolean"
    )
      continue;
    logs.set(row.pid, {
      path: row.path,
      log: {
        numTurns: s.numTurns,
        lastAction: s.lastAction,
        finished: s.finished,
        isError: s.isError,
        limited: s.limited,
      },
    });
  }
  const seen = new Set<string>();
  return {
    ...report,
    processes: [...report.processes]
      .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds || a.pid - b.pid)
      .filter((p) => {
        const path = logs.get(p.pid)?.path;
        if (!path) return true;
        const key = `${p.tool}:${path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((p) => {
        const entry = logs.get(p.pid);
        return { ...p, ...workerLogIdentity(entry?.path ?? "", p.tool), log: entry?.log ?? null };
      }),
  };
}

function eventOf(line: string | undefined): Record<string, unknown> | null {
  if (!line?.trim()) return null;
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null; // a line longer than the read window, or still being written
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

function sections(stdout: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@")) {
      current = line.slice(2).trim();
      map.set(current, []);
    } else map.get(current)?.push(line);
  }
  return map;
}

export function parseWorkerProbe(stdout: string): WorkerReport {
  const s = sections(stdout);
  const processes = parseProcesses((s.get("ps") ?? []).join("\n"));
  const statLine = (s.get("log") ?? []).find((l) => l.includes("|"));
  if (!statLine) return { processes, latestLog: null };
  const [path = "", mtime = "0", size = "0"] = statLine.split("|");
  const now = Number((s.get("now") ?? [])[0] ?? mtime);
  const first = eventOf((s.get("first") ?? [])[0]);
  const last = eventOf((s.get("last") ?? [])[0]);
  const lastType = str(last?.type);
  const lastSubtype = str(last?.subtype);
  return {
    processes,
    latestLog: {
      file: basename(path),
      sizeBytes: Number(size),
      ageSeconds: Math.max(0, now - Number(mtime)),
      sessionId: str(first?.session_id) ?? str(last?.session_id),
      model: str(first?.model),
      lastEvent: lastType === null ? null : lastSubtype ? `${lastType}/${lastSubtype}` : lastType,
      finished: lastType === "result",
      isError: typeof last?.is_error === "boolean" ? last.is_error : null,
      numTurns: typeof last?.num_turns === "number" ? last.num_turns : null,
    },
  };
}

export type Workers =
  | ({ readonly available: true } & WorkerReport)
  | { readonly available: false; readonly reason: string };

/** Never throws: a missing wsl.exe, a stopped distro or a probe error becomes "unavailable". */
export async function readWorkers(run: Runner, target: WslTarget): Promise<Workers> {
  try {
    const stdout = await runChecked(run, wslCommand(WORKER_PROBE, target, 30_000));
    const report = parseWorkerProbe(stdout);
    if (report.processes.length === 0) return { available: true, ...report };
    const command = wslCommand(
      `${WSL_NODE_ENV} node --input-type=module - ${report.processes.map((p) => String(p.pid)).join(" ")}`,
      target,
      30_000,
    );
    // A log read failure must not discard the process snapshot.
    const logs = await run({ ...command, input: processLogCollector() });
    return { available: true, ...attachProcessLogs(report, logs.code === 0 ? logs.stdout : "") };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, reason: reason.split("\n")[0] ?? reason };
  }
}
