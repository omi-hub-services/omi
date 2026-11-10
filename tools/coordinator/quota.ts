// Worker subscription quota (OMI-053, ADR-0014): one WSL call reads Codex limits through
// `codex app-server` (no model call), the newest Claude `rate_limit_event` per profile from the
// worker logs in ~/omi-runs, and with `probe` one minimal Haiku call per Claude profile. Parsing
// and pickProfile are pure. Redaction happens at the parse boundary: a QuotaReading keeps only
// percentages, reset times, status, plan type, the reset-credit count and the data age, never
// `accountId`, emails, tokens or credit ids. Temporary dev tooling; OMI-004 runtime replaces it.
import {
  RUNS_DIR_FROM_HOME,
  type QuotaSettings,
  type WorkerProfile,
  type WslTarget,
} from "./coordinator-settings.ts";
import { asObject, type JsonObject } from "./json-shape.ts";
import {
  runChecked,
  WSL_NODE_ENV,
  wslCommand,
  type Command,
  type Runner,
} from "./process-runner.ts";

// ── remote collector ─────────────────────────────────────────────────────────
// Plain JavaScript run in WSL as `node --input-type=module -` (source on stdin, so the bash
// payload stays free of quotes). Emits one JSON line per finding; the host parses them.
// argv: <runs dir under $HOME> <probe 0|1> <tool:profile>...
export const REMOTE_COLLECTOR = String.raw`
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const argv = process.argv.slice(process.argv[1] === "-" ? 2 : 1);
const [runs, probe, ...targets] = argv;
const home = homedir();
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const fail = (tool, profile, message) => emit({ kind: "error", tool, profile, message });
const MAX_LOGS = 30;

function lastRateLimitEvent(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("rate_limit_event")) continue;
    try {
      const ev = JSON.parse(lines[i]);
      if (ev && ev.type === "rate_limit_event") return ev;
    } catch {}
  }
  return null;
}

function logs() {
  const dir = join(home, runs);
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith("omi-") && n.endsWith(".jsonl")); } catch { return; }
  const files = names.map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.m - a.m);
  for (const f of files.slice(0, MAX_LOGS)) {
    const event = lastRateLimitEvent(readFileSync(join(dir, f.n), "utf8"));
    if (event) emit({ kind: "log", file: f.n, mtime: Math.floor(f.m / 1000), event });
  }
}

function codex(profile) {
  return new Promise((resolve) => {
    const env = { ...process.env, CODEX_HOME: join(home, ".codex-profiles", profile) };
    const child = spawn("codex", ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    let done = false;
    const finish = (o) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      emit(o);
      child.kill();
      resolve();
    };
    const timer = setTimeout(() => finish({ kind: "error", tool: "codex", profile, message: "codex app-server timed out" }), 30000);
    child.on("error", () => finish({ kind: "error", tool: "codex", profile, message: "codex could not start" }));
    child.on("close", () => finish({ kind: "error", tool: "codex", profile, message: "codex app-server exited without a result" }));
    child.stdin.on("error", () => {});
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    child.stdout.setEncoding("utf8").on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (m.id === 2) {
          finish(m.error
            ? { kind: "error", tool: "codex", profile, message: "account/rateLimits/read failed" }
            : { kind: "codex", profile, result: m.result });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "omi-coordinator-quota", version: "0.0.0" } } });
  });
}

function claudeProbe(profile) {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(home, ".claude-profiles", profile) };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const args = ["-p", "--model", "haiku", "--max-turns", "1", "--tools", "", "--output-format", "stream-json", "--verbose"];
    const child = spawn("claude", args, { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"], timeout: 120000 });
    let out = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const event = lastRateLimitEvent(out);
      if (event) emit({ kind: "probe", profile, event });
      else fail("claude", profile, "probe returned no rate_limit_event");
      resolve();
    };
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.on("error", finish);
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end("reply ok");
  });
}

emit({ kind: "now", now: Math.floor(Date.now() / 1000) });
logs();
const jobs = targets.map((t) => {
  const [tool, profile] = t.split(":");
  if (tool === "codex") return codex(profile);
  return probe === "1" ? claudeProbe(profile) : Promise.resolve();
});
await Promise.all(jobs);
`;

const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;

export function quotaCommand(
  target: WslTarget,
  profiles: readonly WorkerProfile[],
  probe: boolean,
): Command {
  const targets = profiles.map((p) => {
    if (!PROFILE_NAME.test(p.profile)) throw new Error(`invalid profile name "${p.profile}"`);
    return `${p.tool}:${p.profile}`;
  });
  const payload = [
    WSL_NODE_ENV,
    "node",
    "--input-type=module",
    "-",
    RUNS_DIR_FROM_HOME,
    probe ? "1" : "0",
  ]
    .concat(targets)
    .join(" ");
  return { ...wslCommand(payload, target, probe ? 240_000 : 60_000), input: REMOTE_COLLECTOR };
}

// ── parsing (pure) ───────────────────────────────────────────────────────────
export interface QuotaWindow {
  readonly usedPercent: number;
  /** Unix seconds. */
  readonly resetsAt: number | null;
}

export interface QuotaReading {
  readonly source: "codex-app-server" | "claude-log" | "claude-probe";
  /** Unix seconds when the numbers were current (log mtime for Claude logs). */
  readonly observedAt: number;
  readonly fiveHour: QuotaWindow | null;
  readonly sevenDay: QuotaWindow | null;
  readonly status: string | null;
  /** The provider reports the limit as reached right now. */
  readonly limited: boolean;
  readonly planType: string | null;
  /** Codex free reset credits left; reported only, never spent by tooling. */
  readonly resetCredits: number | null;
}

export interface ProfileQuota extends WorkerProfile {
  readonly reading: QuotaReading | null;
  readonly note: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const objOrNull = (v: unknown): JsonObject | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;
const round1 = (n: number) => Math.round(n * 10) / 10;

function codexWindow(raw: unknown): QuotaWindow | null {
  const w = objOrNull(raw);
  const used = num(w?.usedPercent);
  return used === null ? null : { usedPercent: round1(used), resetsAt: num(w?.resetsAt) };
}

/** `result` of `account/rateLimits/read` (codex-cli 0.167.0). */
export function parseCodexRateLimits(result: unknown, observedAt: number): QuotaReading {
  const root = asObject(result, "codex rateLimits result");
  const limits = asObject(root.rateLimits, "codex rateLimits");
  const windows = [codexWindow(limits.primary), codexWindow(limits.secondary)];
  const durations = [objOrNull(limits.primary), objOrNull(limits.secondary)].map((w) =>
    num(w?.windowDurationMins),
  );
  // primary is the 5-hour window and secondary the weekly one; the durations confirm it.
  const swapped = (durations[0] ?? 0) > (durations[1] ?? Infinity);
  const reached = text(limits.rateLimitReachedType);
  return {
    source: "codex-app-server",
    observedAt,
    fiveHour: windows[swapped ? 1 : 0] ?? null,
    sevenDay: windows[swapped ? 0 : 1] ?? null,
    status: reached ?? "allowed",
    limited: reached !== null,
    planType: text(limits.planType),
    resetCredits: num(objOrNull(root.rateLimitResetCredits)?.availableCount),
  };
}

function claudeWindow(raw: unknown): QuotaWindow | null {
  const w = objOrNull(raw);
  const utilization = num(w?.utilization);
  return utilization === null
    ? null
    : { usedPercent: round1(utilization * 100), resetsAt: num(w?.resetsAt) };
}

/** A stream-json `rate_limit_event` line from `claude -p --output-format stream-json`. */
export function parseClaudeRateLimitEvent(
  event: unknown,
  observedAt: number,
  source: "claude-log" | "claude-probe",
): QuotaReading {
  const info = asObject(asObject(event, "rate_limit_event").rate_limit_info, "rate_limit_info");
  const unified = objOrNull(info.unifiedWindows);
  const status = text(info.status);
  return {
    source,
    observedAt,
    fiveHour: claudeWindow(unified?.five_hour),
    sevenDay: claudeWindow(unified?.seven_day),
    status,
    limited: status === "rejected",
    planType: null,
    resetCredits: null,
  };
}

const LOG_NAME = /^omi-\d+-(?:(.+)-)?\d{8}-\d{6}\.jsonl$/;

/** Claude profile a worker log belongs to: `omi-NNN-<profile>-<ts>.jsonl`, else the legacy one. */
export function logProfile(
  file: string,
  claudeProfiles: readonly string[],
  legacyLogProfile: string | null,
): string | null {
  const m = LOG_NAME.exec(file);
  if (!m) return null;
  if (m[1] === undefined) return legacyLogProfile;
  return claudeProfiles.includes(m[1]) ? m[1] : null;
}

/** Turns the collector's JSON lines into one redacted entry per configured profile. */
export function parseQuotaOutput(
  stdout: string,
  profiles: readonly WorkerProfile[],
  legacyLogProfile: string | null,
): { now: number; profiles: ProfileQuota[] } {
  let now = Math.floor(Date.now() / 1000);
  const codex = new Map<string, QuotaReading>();
  const probes = new Map<string, QuotaReading>();
  const logs = new Map<string, QuotaReading>();
  const notes = new Map<string, string>();
  const key = (tool: string, profile: string) => `${tool}:${profile}`;
  const claudeNames = profiles.filter((p) => p.tool === "claude").map((p) => p.profile);
  const lines = stdout.split("\n").flatMap((line) => {
    const o = objOrNull(safeJson(line));
    return o ? [o] : [];
  });
  for (const o of lines) if (o.kind === "now") now = num(o.now) ?? now;
  for (const o of lines) {
    const profile = text(o.profile) ?? "";
    try {
      if (o.kind === "codex") codex.set(profile, parseCodexRateLimits(o.result, now));
      else if (o.kind === "probe") {
        probes.set(profile, parseClaudeRateLimitEvent(o.event, now, "claude-probe"));
      } else if (o.kind === "log") {
        const owner = logProfile(text(o.file) ?? "", claudeNames, legacyLogProfile);
        // Lines arrive newest log first; keep the newest per profile.
        if (owner !== null && !logs.has(owner)) {
          logs.set(owner, parseClaudeRateLimitEvent(o.event, num(o.mtime) ?? 0, "claude-log"));
        }
      } else if (o.kind === "error") {
        notes.set(key(text(o.tool) ?? "", profile), text(o.message) ?? "error");
      }
    } catch (error) {
      const what = error instanceof Error ? error.message : "unrecognised shape";
      notes.set(key(o.kind === "codex" ? "codex" : "claude", profile), `unreadable data: ${what}`);
    }
  }
  return {
    now,
    profiles: profiles.map((p) => {
      const reading =
        p.tool === "codex"
          ? (codex.get(p.profile) ?? null)
          : (probes.get(p.profile) ?? logs.get(p.profile) ?? null);
      const fallback =
        p.tool === "claude"
          ? `no worker log named with this profile in ~/${RUNS_DIR_FROM_HOME}`
          : null;
      const note = reading ? null : (notes.get(key(p.tool, p.profile)) ?? fallback);
      return { ...p, reading, note };
    }),
  };
}

function safeJson(line: string): unknown {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export type QuotaReport =
  | { readonly available: true; readonly now: number; readonly profiles: readonly ProfileQuota[] }
  | { readonly available: false; readonly reason: string };

/** Never throws: a missing wsl.exe, node or codex degrades to "unavailable" or a profile note. */
export async function readQuota(
  run: Runner,
  target: WslTarget,
  profiles: readonly WorkerProfile[],
  settings: QuotaSettings,
  probe: boolean,
): Promise<QuotaReport> {
  try {
    const stdout = await runChecked(run, quotaCommand(target, profiles, probe));
    return { available: true, ...parseQuotaOutput(stdout, profiles, settings.legacyLogProfile) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, reason: reason.split("\n")[0] ?? reason };
  }
}

// ── profile choice (pure) ────────────────────────────────────────────────────
export type WorkerKind = "claude" | "codex" | "claude+codex-live";
export const WORKER_KINDS: readonly WorkerKind[] = ["claude", "codex", "claude+codex-live"];

export interface Candidate {
  readonly tool: WorkerProfile["tool"];
  readonly profile: string;
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly fiveHourLeft: number | null;
  readonly sevenDayLeft: number | null;
  /** Remaining share of the tighter window minus the Coordinator-shared penalty. */
  readonly score: number | null;
  /** Why the profile is below threshold; null when usable. */
  readonly blocked: string | null;
  /** When every blocking window has reset (unix seconds), if known. */
  readonly blockedUntil: number | null;
  readonly resetCredits: number | null;
}

export type PickResult =
  | {
      readonly ok: true;
      readonly chosen: readonly Candidate[];
      readonly ranked: readonly Candidate[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly earliestReset: number | null;
      readonly ranked: readonly Candidate[];
    };

/** Share (%) of a window left; a window whose reset time has passed is full again. */
export function windowLeft(w: QuotaWindow | null, now: number): number | null {
  if (w === null) return null;
  if (w.resetsAt !== null && w.resetsAt <= now) return 100;
  return round1(Math.max(0, 100 - w.usedPercent));
}

export function evaluate(q: ProfileQuota, settings: QuotaSettings, now: number): Candidate {
  const r = q.reading;
  const base = { tool: q.tool, profile: q.profile, resetCredits: r?.resetCredits ?? null };
  if (!r) {
    const none = { fiveHourLeft: null, sevenDayLeft: null, score: null };
    return { ...base, ...none, freshness: "unknown", blocked: null, blockedUntil: null };
  }
  const fiveHourLeft = windowLeft(r.fiveHour, now);
  const sevenDayLeft = windowLeft(r.sevenDay, now);
  const reasons: string[] = [];
  const resets: (number | null)[] = [];
  if (fiveHourLeft !== null && fiveHourLeft < settings.minFiveHourLeftPercent) {
    reasons.push(`5h ${String(fiveHourLeft)}% left < ${String(settings.minFiveHourLeftPercent)}%`);
    resets.push(r.fiveHour?.resetsAt ?? null);
  }
  if (sevenDayLeft !== null && sevenDayLeft < settings.minSevenDayLeftPercent) {
    reasons.push(`7d ${String(sevenDayLeft)}% left < ${String(settings.minSevenDayLeftPercent)}%`);
    resets.push(r.sevenDay?.resetsAt ?? null);
  }
  if (r.limited && reasons.length === 0) {
    reasons.push(`limit reached (${r.status ?? "unknown"})`);
    for (const w of [r.fiveHour, r.sevenDay]) {
      if (w?.resetsAt != null && w.resetsAt > now) resets.push(w.resetsAt);
    }
  }
  const known = [fiveHourLeft, sevenDayLeft].filter((n): n is number => n !== null);
  const penalty = q.sharesCoordinatorAccount ? settings.coordinatorSharedPenalty : 0;
  const blockedUntil =
    resets.length === 0 || resets.some((t) => t === null)
      ? null
      : Math.max(...resets.filter((t): t is number => t !== null));
  return {
    ...base,
    freshness: now - r.observedAt > settings.staleAfterMinutes * 60 ? "stale" : "fresh",
    fiveHourLeft,
    sevenDayLeft,
    score: known.length === 0 ? null : round1(Math.min(...known) - penalty),
    blocked: reasons.length === 0 ? null : reasons.join(", "),
    blockedUntil,
  };
}

const FRESHNESS_RANK = { fresh: 0, stale: 1, unknown: 2 } as const;

/** Fresh before stale before unknown, then higher score, then name (deterministic). */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      FRESHNESS_RANK[a.freshness] - FRESHNESS_RANK[b.freshness] ||
      (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
      a.profile.localeCompare(b.profile),
  );
}

/**
 * Chooses the worker profile(s) for a task kind. `claude+codex-live` needs a Claude writer and a
 * Codex profile for live tests, both above threshold. Codex reset credits are never spent here.
 */
export function pickProfile(
  kind: WorkerKind,
  quotas: readonly ProfileQuota[],
  settings: QuotaSettings,
  now: number,
): PickResult {
  const tools: WorkerProfile["tool"][] =
    kind === "claude+codex-live" ? ["claude", "codex"] : [kind];
  const chosen: Candidate[] = [];
  const ranked: Candidate[] = [];
  const refusals: string[] = [];
  const waits: (number | null)[] = [];
  for (const tool of tools) {
    const list = rankCandidates(
      quotas.filter((q) => q.tool === tool).map((q) => evaluate(q, settings, now)),
    );
    ranked.push(...list);
    const best = list.find((c) => c.blocked === null);
    if (best) {
      chosen.push(best);
      continue;
    }
    if (list.length === 0) {
      refusals.push(`${tool}: no profile configured`);
      waits.push(null);
      continue;
    }
    refusals.push(`${tool}: ${list.map((c) => `${c.profile} ${c.blocked ?? ""}`).join("; ")}`);
    const known = list.map((c) => c.blockedUntil).filter((t): t is number => t !== null);
    waits.push(known.length === 0 ? null : Math.min(...known));
  }
  if (refusals.length === 0) return { ok: true, chosen, ranked };
  // Every refused tool must have reset before the task can run.
  const earliestReset = waits.some((t) => t === null)
    ? null
    : Math.max(...waits.filter((t): t is number => t !== null));
  return { ok: false, reason: refusals.join(" | "), earliestReset, ranked };
}

// ── formatting ───────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");

/** Local time `YYYY-MM-DD HH:MM`. */
export function localTime(unix: number): string {
  const d = new Date(unix * 1000);
  const date = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function age(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${String(s)}s`;
  if (s < 7200) return `${String(Math.round(s / 60))}m`;
  if (s < 172800) return `${String(Math.round(s / 3600))}h`;
  return `${String(Math.round(s / 86400))}d`;
}

function windowText(label: string, w: QuotaWindow | null, now: number): string {
  const left = windowLeft(w, now);
  if (w === null || left === null) return `${label} -`;
  const reset = w.resetsAt === null ? "" : ` (resets ${localTime(w.resetsAt)})`;
  return `${label} ${String(left)}% left${reset}`;
}

/** One status line per profile: tool, profile, 5h/7d left with local reset times, data age. */
export function formatQuotaLine(q: ProfileQuota, now: number): string {
  const head = `${q.tool} ${q.profile}${q.sharesCoordinatorAccount ? " (shares Coordinator account)" : ""}`;
  const r = q.reading;
  if (!r) return `${head}: unknown${q.note ? ` (${q.note})` : ""}`;
  const parts = [
    windowText("5h", r.fiveHour, now),
    windowText("7d", r.sevenDay, now),
    r.status ?? "status -",
  ];
  if (r.planType) parts.push(`plan ${r.planType}`);
  if (r.resetCredits !== null) parts.push(`${String(r.resetCredits)} reset credits (PO decision)`);
  parts.push(`data ${age(now - r.observedAt)} old (${r.source})`);
  return `${head}: ${parts.join(", ")}`;
}

/** status.ts "Quota" section: one line per configured profile, `unknown` without data. */
export function formatQuotaSection(quota: QuotaReport): string[] {
  if (!quota.available) return [`Quota: unavailable (${quota.reason.slice(0, 120)})`];
  return [
    "Quota (share left, resets in local time; no probe — pick-profile --probe refreshes Claude):",
    ...quota.profiles.map((q) => `  ${formatQuotaLine(q, quota.now)}`),
  ];
}

function candidateText(c: Candidate): string {
  const left = (n: number | null) => (n === null ? "-" : `${String(n)}%`);
  if (c.freshness === "unknown") return `${c.tool} ${c.profile} (no quota data)`;
  return (
    `${c.tool} ${c.profile} score ${c.score === null ? "-" : String(c.score)}` +
    ` (5h ${left(c.fiveHourLeft)} left, 7d ${left(c.sevenDayLeft)} left, ${c.freshness})`
  );
}

/** `pick-profile` output: chosen lines and the ranking, or one `refused:` line. */
export function formatPick(label: string, result: PickResult): string[] {
  const others = result.ranked.map((c) =>
    c.blocked === null ? candidateText(c) : `${candidateText(c)} blocked: ${c.blocked}`,
  );
  const credits = result.ranked
    .filter((c) => c.resetCredits !== null && c.resetCredits > 0)
    .map((c) => `${c.tool} ${c.profile} has ${String(c.resetCredits)} reset credits (PO decision)`);
  if (!result.ok) {
    const at = result.earliestReset === null ? "unknown" : localTime(result.earliestReset);
    return [`${label}: refused: ${result.reason}; earliest reset ${at}`, ...credits];
  }
  const chosen = result.chosen.map((c) => `${label}: ${c.tool} ${c.profile}`);
  const reason = result.chosen.map((c) => {
    const why =
      c.freshness === "fresh"
        ? "highest score among fresh readings"
        : `no fresh reading, ${c.freshness}`;
    return `  reason: ${candidateText(c)}; ${why}`;
  });
  return [...chosen, ...reason, "  ranked:", ...others.map((o) => `    ${o}`), ...credits];
}
