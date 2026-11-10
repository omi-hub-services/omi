// WSL worker probe: one bash payload lists processes and the newest stream-json log in
// ~/omi-runs; parsing is pure. Only event metadata (type, subtype, ids, counters) is read from
// the log, never message text.
import { RUNS_DIR_FROM_HOME, type WslTarget } from "./coordinator-settings.ts";
import { runChecked, wslCommand, type Runner } from "./process-runner.ts";

const MAX_LINE = 65536;

/** Payload for `bash -lc`; free of `"` and `\` so it survives Windows command-line quoting. */
export const WORKER_PROBE = [
  "echo @@ps",
  "ps -eo pid=,etimes=,args=",
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
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const args = m[3].trim().split(/\s+/);
    const tool = workerTool(args);
    if (!tool) continue;
    out.push({
      pid: Number(m[1]),
      tool,
      headless: args.includes("-p") || args.includes("--print") || args.includes("exec"),
      elapsedSeconds: Number(m[2]),
    });
  }
  return out;
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
    return { available: true, ...parseWorkerProbe(stdout) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, reason: reason.split("\n")[0] ?? reason };
  }
}
