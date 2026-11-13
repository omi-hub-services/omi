// Worker subscription quota (OMI-053, ADR-0014): one WSL call reads Codex limits through
// `codex app-server` (no model call), the newest Claude `rate_limit_event` per profile from the
// worker logs in ~/omi-runs, and with `probe` one minimal Haiku call per Claude profile. Parsing
// and pickProfile are pure. Redaction happens at the parse boundary: a QuotaReading keeps only
// percentages, reset times, status, plan type, the reset-credit count and the data age, never
// `accountId`, emails, tokens or credit ids. Temporary dev tooling; OMI-004 runtime replaces it.
import "../register-ts-imports.ts";
import {
  EXPIRY_PROBE_COOLDOWN_MS,
  RUNS_DIR_FROM_HOME,
  QUOTA_MIN_INTERVAL_MS,
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

// The expiry-probe rule is the framework's (ADR-0033); the collector below embeds its source.
export const { decideExpiryProbe } = await import("../../src/domain/profiles/quota-policy.ts");

const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;

/** `false`: usage only. `true`: also one Haiku probe per Claude profile. `"expired"`: usage, plus
 * one probe for each profile whose token expired, when the shared rule allows it. */
export type QuotaMode = boolean | "expired";

export function quotaCommand(
  target: WslTarget,
  profiles: readonly WorkerProfile[],
  mode: QuotaMode,
): Command {
  const probe = mode !== false;
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
    mode === "expired" ? "expired" : probe ? "1" : "0",
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

/** Weekly window scoped to one model (usage endpoint `weekly_scoped`), e.g. "Fable". */
export interface ModelWindow {
  readonly model: string;
  readonly usedPercent: number;
  /** Unix seconds. */
  readonly resetsAt: number | null;
}

export interface QuotaReading {
  readonly source: "codex-app-server" | "claude-log" | "claude-probe" | "claude-usage-api";
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
  /** Per-model weekly windows; only the usage endpoint reports them. */
  readonly modelWindows: readonly ModelWindow[];
}

export interface ProfileQuota extends WorkerProfile {
  readonly reading: QuotaReading | null;
  readonly note: string | null;
  /** Unix seconds the OAuth token expired at; null when it is valid or not known to be expired. */
  readonly tokenExpiresAt: number | null;
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
  const reached = text(limits.rateLimitReachedType);
  // primary is the 5-hour window and secondary the weekly one (codex-cli 0.167.0).
  return {
    source: "codex-app-server",
    observedAt,
    fiveHour: codexWindow(limits.primary),
    sevenDay: codexWindow(limits.secondary),
    status: reached ?? "allowed",
    limited: reached !== null,
    planType: text(limits.planType),
    resetCredits: num(objOrNull(root.rateLimitResetCredits)?.availableCount),
    modelWindows: [],
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
  const info = objOrNull(objOrNull(event)?.rate_limit_info);
  if (!info) throw new Error("rate_limit_info: expected an object");
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
    modelWindows: [],
  };
}

const iso = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/** `utilization` is 0-100 here, unlike the 0-1 of the log event. Null stays null; junk throws. */
function usageWindow(raw: unknown, name: string): QuotaWindow | null {
  if (raw === null || raw === undefined) return null;
  const w = objOrNull(raw);
  const used = num(w?.utilization);
  if (used === null) throw new Error(`usage ${name} has no numeric utilization`);
  return { usedPercent: round1(used), resetsAt: iso(w?.resets_at) };
}

/**
 * The collector's trimmed `/api/oauth/usage` body (ADR-0033): `five_hour` / `seven_day` windows
 * and `limits[]`, of which only `weekly_scoped` entries with a model name are kept. Throws on a
 * shape with neither window, so the caller falls back to the log.
 */
export function parseClaudeUsage(usage: unknown, observedAt: number): QuotaReading {
  const root = objOrNull(usage);
  if (!root) throw new Error("claude usage: expected an object");
  const fiveHour = usageWindow(root.five_hour, "five_hour");
  const sevenDay = usageWindow(root.seven_day, "seven_day");
  if (fiveHour === null && sevenDay === null)
    throw new Error("usage has no five_hour or seven_day");
  const limits = Array.isArray(root.limits) ? (root.limits as unknown[]) : [];
  const modelWindows = limits.flatMap((l): ModelWindow[] => {
    const e = objOrNull(l);
    const model = text(e?.model);
    const percent = num(e?.percent);
    if (e?.kind !== "weekly_scoped" || model === null || model === "" || percent === null)
      return [];
    return [{ model, usedPercent: round1(percent), resetsAt: iso(e.resets_at) }];
  });
  const full = [fiveHour, sevenDay].some((w) => w !== null && w.usedPercent >= 100);
  return {
    source: "claude-usage-api",
    observedAt,
    fiveHour,
    sevenDay,
    status: full ? "rejected" : "allowed",
    limited: full,
    planType: null,
    resetCredits: null,
    modelWindows,
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
  const usages = new Map<string, QuotaReading>();
  const caches = new Map<string, QuotaReading>();
  const notes = new Map<string, string>();
  const expired = new Map<string, number>();
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
      else if (o.kind === "usage") usages.set(profile, parseClaudeUsage(o.usage, now));
      else if (o.kind === "cache" || o.kind === "probe-reading") {
        const reading = parseCachedReading(o.reading);
        if (reading) (o.kind === "cache" ? caches : probes).set(profile, reading);
      } else if (o.kind === "probe") {
        probes.set(profile, parseClaudeRateLimitEvent(o.event, now, "claude-probe"));
      } else if (o.kind === "log") {
        const owner = logProfile(text(o.file) ?? "", claudeNames, legacyLogProfile);
        // Lines arrive newest log first; keep the newest per profile.
        if (owner !== null && !logs.has(owner)) {
          logs.set(owner, parseClaudeRateLimitEvent(o.event, num(o.mtime) ?? 0, "claude-log"));
        }
      } else if (o.kind === "expired") {
        const at = num(o.expiresAt);
        if (at !== null) expired.set(profile, Math.floor(at / 1000));
      } else if (o.kind === "error") {
        notes.set(key(text(o.tool) ?? "", profile), text(o.message) ?? "error");
      }
    } catch (error) {
      const what = error instanceof Error ? error.message : "unrecognised shape";
      const tool = o.kind === "codex" ? "codex" : o.kind === "usage" ? "claude-usage" : "claude";
      notes.set(key(tool, profile), `unreadable data: ${what}`);
    }
  }
  return {
    now,
    profiles: profiles.map((p) => {
      const reading =
        p.tool === "codex"
          ? (codex.get(p.profile) ?? null)
          : (probes.get(p.profile) ??
            usages.get(p.profile) ??
            caches.get(p.profile) ??
            logs.get(p.profile) ??
            null);
      const fallback =
        p.tool === "claude"
          ? `no worker log named with this profile in ~/${RUNS_DIR_FROM_HOME}`
          : null;
      // A usage-endpoint failure is kept even when a log reading stands in for it.
      const usageNote = p.tool === "claude" ? notes.get(key("claude-usage", p.profile)) : undefined;
      const note = reading
        ? usageNote && !probes.has(p.profile) && !usages.has(p.profile)
          ? `usage api: ${usageNote}`
          : null
        : (notes.get(key(p.tool, p.profile)) ??
          (usageNote ? `usage api: ${usageNote}; ${fallback ?? ""}` : fallback));
      const tokenExpiresAt = p.tool === "claude" ? (expired.get(p.profile) ?? null) : null;
      return { ...p, reading, note, tokenExpiresAt };
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
  mode: QuotaMode,
): Promise<QuotaReport> {
  try {
    const stdout = await runChecked(run, quotaCommand(target, profiles, mode));
    return { available: true, ...parseQuotaOutput(stdout, profiles, settings.legacyLogProfile) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, reason: reason.split("\n")[0] ?? reason };
  }
}

// ── profile choice (pure) ────────────────────────────────────────────────────
export type WorkerKind = "claude" | "codex" | "claude+codex-live" | "quality";
export const WORKER_KINDS: readonly WorkerKind[] = [
  "claude",
  "codex",
  "claude+codex-live",
  "quality",
];

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
  /** Why the data may be old: `token expired` or the collector error name; null when none. */
  readonly note: string | null;
  /** Seconds since the reading was current; null without a reading. */
  readonly dataAgeSeconds: number | null;
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

/** The weekly window of `model` (case-insensitive exact name), if the reading has one. */
export function findModelWindow(
  windows: readonly ModelWindow[],
  model: string,
): ModelWindow | undefined {
  const wanted = model.trim().toLowerCase();
  return windows.find((w) => w.model.trim().toLowerCase() === wanted);
}

/** Share (%) of a window left; a window whose reset time has passed is full again. */
export function windowLeft(
  w: Pick<QuotaWindow, "usedPercent" | "resetsAt"> | null,
  now: number,
): number | null {
  if (w === null) return null;
  if (w.resetsAt !== null && w.resetsAt <= now) return 100;
  return round1(Math.max(0, 100 - w.usedPercent));
}

/**
 * `probed`: the reading came from a run with `--probe`. Without it a profile with no data is
 * blocked (it may be exhausted, e.g. the Coordinator's own account); after a probe that still
 * found nothing it stays usable, ranked last.
 */
export function evaluate(
  q: ProfileQuota,
  settings: QuotaSettings,
  now: number,
  probed = false,
  model: string | null = null,
): Candidate {
  const r = q.reading;
  const base = {
    tool: q.tool,
    profile: q.profile,
    resetCredits: r?.resetCredits ?? null,
    note: q.tokenExpiresAt == null ? q.note : "token expired",
    dataAgeSeconds: r ? Math.max(0, now - r.observedAt) : null,
  };
  if (!r) {
    const none = { fiveHourLeft: null, sevenDayLeft: null, score: null };
    const blocked = probed ? null : "no quota data; rerun pick-profile with --probe";
    return { ...base, ...none, freshness: "unknown", blocked, blockedUntil: null };
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
  // A per-model weekly window is display-only, except for a worker assigned exactly that model.
  const scoped = model === null ? undefined : findModelWindow(r.modelWindows, model);
  if (scoped) {
    const left = windowLeft(scoped, now);
    if (left !== null && left < settings.minSevenDayLeftPercent) {
      reasons.push(
        `${scoped.model} weekly ${String(left)}% left < ${String(settings.minSevenDayLeftPercent)}%`,
      );
      resets.push(scoped.resetsAt);
    }
  }
  // A reported limit only blocks while a window is still to reset: once every reset time has
  // passed, an old `rejected` reading no longer says anything about now.
  const pending = [r.fiveHour, r.sevenDay].flatMap((w) =>
    w?.resetsAt != null && w.resetsAt > now ? [w.resetsAt] : [],
  );
  if (r.limited && reasons.length === 0 && pending.length > 0) {
    reasons.push(`limit reached (${r.status ?? "unknown"})`);
    resets.push(...pending);
  }
  // Limited with no window carrying a reset time: nothing says when it clears, so stay blocked.
  const anyResetsAt = [r.fiveHour, r.sevenDay].some((w) => w?.resetsAt != null);
  if (r.limited && reasons.length === 0 && !anyResetsAt) {
    reasons.push(`limit reached (${r.status ?? "unknown"}), no reset time`);
    resets.push(null);
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
 * Without `probed` a profile with no quota data is never chosen (see `evaluate`). `model` is the
 * Claude worker's model: a profile whose weekly window for exactly that model is below the 7d
 * threshold is refused with a reason; per-model windows never change the score.
 */
export function pickProfile(
  kind: WorkerKind,
  quotas: readonly ProfileQuota[],
  settings: QuotaSettings,
  now: number,
  probed = false,
  model: string | null = null,
): PickResult {
  if (kind === "quality") {
    const ranked = rankCandidates(
      quotas.map((q) => evaluate(q, settings, now, probed, q.tool === "claude" ? model : null)),
    );
    const best = ranked.find((c) => c.blocked === null);
    const resets = ranked.flatMap((c) => (c.blockedUntil === null ? [] : [c.blockedUntil]));
    return best === undefined
      ? {
          ok: false,
          reason: "no eligible quality worker profile",
          earliestReset: resets.length === 0 ? null : Math.min(...resets),
          ranked,
        }
      : { ok: true, chosen: [best], ranked };
  }
  const tools: WorkerProfile["tool"][] =
    kind === "claude+codex-live" ? ["claude", "codex"] : [kind];
  const chosen: Candidate[] = [];
  const ranked: Candidate[] = [];
  const refusals: string[] = [];
  const waits: (number | null)[] = [];
  for (const tool of tools) {
    const list = rankCandidates(
      quotas
        .filter((q) => q.tool === tool)
        .map((q) => evaluate(q, settings, now, probed, tool === "claude" ? model : null)),
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

/** `token expired, data 9h old` for a profile whose token expired; null otherwise. */
export function tokenExpiredText(q: ProfileQuota, now: number): string | null {
  if (q.tokenExpiresAt == null) return null;
  return q.reading
    ? `token expired, data ${age(now - q.reading.observedAt)} old`
    : "token expired, no data";
}

/** Weekly share left per model, e.g. `Fable 99%`; empty without model windows. */
export function modelLeftText(r: QuotaReading, now: number): string[] {
  return r.modelWindows.flatMap((w) => {
    const left = windowLeft(w, now);
    return left === null ? [] : [`${w.model} ${String(left)}%`];
  });
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
  if (r.modelWindows.length > 0) parts.push(`weekly ${modelLeftText(r, now).join(", ")}`);
  if (r.planType) parts.push(`plan ${r.planType}`);
  if (r.resetCredits !== null) parts.push(`${String(r.resetCredits)} reset credits (PO decision)`);
  parts.push(`data ${age(now - r.observedAt)} old (${r.source})`);
  const fell = q.note ? ` [${q.note}]` : "";
  return `${head}: ${parts.join(", ")}${fell}`;
}

/** status.ts "Quota" section: one line per configured profile, `unknown` without data. */
export function formatQuotaSection(quota: QuotaReport): string[] {
  if (!quota.available) return [`Quota: unavailable (${quota.reason.slice(0, 120)})`];
  return [
    "Quota (share left, resets in local time; Claude from the usage endpoint, cache/log fallback; no probe):",
    ...quota.profiles.map((q) => `  ${formatQuotaLine(q, quota.now)}`),
  ];
}

function candidateText(c: Candidate): string {
  const left = (n: number | null) => (n === null ? "-" : `${String(n)}%`);
  const why =
    c.note === null
      ? ""
      : ` [${c.note}${c.dataAgeSeconds === null ? "" : `, data ${age(c.dataAgeSeconds)} old`}]`;
  if (c.freshness === "unknown") return `${c.tool} ${c.profile} (no quota data)${why}`;
  return (
    `${c.tool} ${c.profile} score ${c.score === null ? "-" : String(c.score)}` +
    ` (5h ${left(c.fiveHourLeft)} left, 7d ${left(c.sevenDayLeft)} left, ${c.freshness})${why}`
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

/** Validates persisted data and keeps only the quota fields; no credential data is cached. */
export function parseCachedReading(raw: unknown): QuotaReading | null {
  const r = objOrNull(raw);
  if (
    !r ||
    !["claude-usage-api", "claude-probe"].includes(String(r.source)) ||
    num(r.observedAt) === null ||
    typeof r.limited !== "boolean" ||
    !(r.status === null || typeof r.status === "string")
  )
    return null;
  const window = (v: unknown): QuotaWindow | null | undefined => {
    if (v === null) return null;
    const w = objOrNull(v);
    if (!w || num(w.usedPercent) === null || !(w.resetsAt === null || num(w.resetsAt) !== null))
      return undefined;
    return {
      usedPercent: Number(w.usedPercent),
      resetsAt: w.resetsAt === null ? null : Number(w.resetsAt),
    };
  };
  const fiveHour = window(r.fiveHour);
  const sevenDay = window(r.sevenDay);
  if (
    fiveHour === undefined ||
    sevenDay === undefined ||
    (!fiveHour && !sevenDay) ||
    !Array.isArray(r.modelWindows)
  )
    return null;
  const modelWindows: ModelWindow[] = [];
  for (const rawModel of r.modelWindows) {
    const m = objOrNull(rawModel);
    const w = window(rawModel);
    if (!m || typeof m.model !== "string" || !w) return null;
    modelWindows.push({ ...w, model: m.model });
  }
  return {
    source: r.source === "claude-probe" ? "claude-probe" : "claude-usage-api",
    observedAt: Number(r.observedAt),
    fiveHour,
    sevenDay,
    status: r.status,
    limited: r.limited,
    modelWindows,
    planType: null,
    resetCredits: null,
  };
}

/** Unix seconds. Retry-After supports both delta seconds and HTTP dates. */
export function quotaRetryAt(
  retryAfter: string | null,
  now: number,
  minimumSeconds: number,
): number {
  const delay = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : null;
  const date = retryAfter === null ? NaN : Date.parse(retryAfter);
  const requested =
    delay !== null
      ? now + delay
      : Number.isFinite(date)
        ? Math.ceil(date / 1000)
        : now + minimumSeconds;
  return Math.max(
    now + minimumSeconds,
    Number.isFinite(requested) ? requested : now + minimumSeconds,
  );
}

/** Pure cache decision: the caller supplies time; a skipped call never refreshes data age. */
export function quotaCacheDecision(
  raw: unknown,
  now: number,
): { call: boolean; reading: QuotaReading | null } {
  const entry = objOrNull(raw);
  const next = num(entry?.nextAllowedAt);
  return { call: next === null || now >= next, reading: parseCachedReading(entry?.reading) };
}

// ── remote collector ─────────────────────────────────────────────────────────
// Plain JavaScript run in WSL as `node --input-type=module -` (source on stdin, so the bash
// payload stays free of quotes). Emits one JSON line per finding; the host parses them.
// argv: <runs dir under $HOME> <probe 0|1|expired> <tool:profile>...

export const REMOTE_COLLECTOR = String.raw`
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const argv = process.argv.slice(process.argv[1] === "-" ? 2 : 1);
const [runs, probe, ...targets] = argv;
const home = homedir();
const emit = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); };
const fail = (tool, profile, message) => emit({ kind: "error", tool, profile, message });
const MAX_LOGS = 30;
const num = ${num.toString()};
const text = ${text.toString()};
const objOrNull = ${objOrNull.toString()};
const round1 = ${round1.toString()};
const iso = ${iso.toString()};
const usageWindow = ${usageWindow.toString()};
const claudeWindow = ${claudeWindow.toString()};
const parseClaudeUsage = ${parseClaudeUsage.toString()};
const parseClaudeRateLimitEvent = ${parseClaudeRateLimitEvent.toString()};
const parseCachedReading = ${parseCachedReading.toString()};
const quotaCacheDecision = ${quotaCacheDecision.toString()};
const quotaRetryAt = ${quotaRetryAt.toString()};
const decideExpiryProbe = ${decideExpiryProbe.toString()};
const minimumSeconds = ${QUOTA_MIN_INTERVAL_MS / 1000};
const expiryCooldownMs = ${EXPIRY_PROBE_COOLDOWN_MS};
const cachePath = join(home, runs, ".quota-cache.json");
const clock = () => Math.floor(Date.now() / 1000);
function loadCache() {
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
async function saveCache(profile, patch) {
  const lock = cachePath + ".write.lock";
  let fd;
  try {
    mkdirSync(join(home, runs), { recursive: true });
    // Serialize read/merge/rename across collectors so different profiles cannot erase each other.
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        try { if (Date.now() - statSync(lock).mtimeMs > 30000) unlinkSync(lock); } catch {}
        fd = openSync(lock, "wx", 0o600);
        break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    if (fd === undefined) throw new Error("cache busy");
    const cache = loadCache();
    cache[profile] = { ...cache[profile], ...patch };
    const tmp = cachePath + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, cachePath);
    return true;
  } catch { usageFail(profile, "cache write failed"); return false; }
  finally { if (fd !== undefined) { closeSync(fd); unlinkSync(lock); } }
}
function cached(profile) {
  const reading = parseCachedReading(loadCache()[profile]?.reading);
  if (reading) emit({ kind: "cache", profile, reading });
}


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
  // A log deleted or unreadable between readdir and stat/read is skipped, not fatal.
  const files = names.flatMap((n) => {
    try { return [{ n, m: statSync(join(dir, n)).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.m - a.m);
  for (const f of files.slice(0, MAX_LOGS)) {
    let text;
    try { text = readFileSync(join(dir, f.n), "utf8"); } catch { continue; }
    const event = lastRateLimitEvent(text);
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

// quiet: the caller re-reads usage next, so the probe only refreshes the token and the cache.
function claudeProbe(profile, quiet) {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(home, ".claude-profiles", profile) };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const args = ["-p", "--model", "haiku", "--max-turns", "1", "--tools", "", "--output-format", "stream-json", "--verbose"];
    const child = spawn("claude", args, { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"], timeout: 120000 });
    let out = "";
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      // Any probe starts the shared expiry-probe cooldown, whoever ran it.
      await saveCache(profile, { probeAt: Date.now() });
      const event = lastRateLimitEvent(out);
      if (event) {
        try {
          const scoped = parseCachedReading(loadCache()[profile]?.reading)?.modelWindows ?? [];
          const reading = { ...parseClaudeRateLimitEvent(event, clock(), "claude-probe"), modelWindows: scoped };
          if (reading.fiveHour || reading.sevenDay) await saveCache(profile, { reading });
          // Emit only quota metadata, never other probe event fields.
          if (!quiet) emit({ kind: "probe-reading", profile, reading });
        } catch { fail("claude", profile, "probe returned unreadable quota"); }
      }
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

// OAuth usage endpoint (undocumented; ADR-0033). The access token is read here, sent only to
// api.anthropic.com and never emitted: a failure carries an HTTP status or an error kind, nothing
// else. The token is not refreshed and nothing is written to the profile directory.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const usageFail = (profile, message) => emit({ kind: "error", tool: "claude-usage", profile, message });

function readOauth(profile) {
  try {
    const raw = JSON.parse(readFileSync(join(home, ".claude-profiles", profile, ".credentials.json"), "utf8"));
    return raw && raw.claudeAiOauth;
  } catch { return undefined; }
}

// A token renews only when claude runs on the profile. The expiry is reported on every read, even
// inside the five-minute spacing, so the cached numbers never stand in silently.
function expiredReport(profile, expiresAt) {
  emit({ kind: "expired", profile, expiresAt });
  usageFail(profile, "token expired");
}

// With autoProbe, one probe renews an expired token when the shared rule allows it (it holds the
// per-profile lock): never the refresh-token grant, only the CLI's own renewal. Usage is then read again.
async function expiredToken(profile, expiresAt, autoProbe) {
  const entry = loadCache()[profile] || {};
  const decision = autoProbe
    ? decideExpiryProbe({ expiresAt, now: Date.now(), lastProbeAt: num(entry.probeAt), probedForExpiresAt: num(entry.probedForExpiresAt), cooldownMs: expiryCooldownMs })
    : { probe: false };
  if (!decision.probe) { expiredReport(profile, expiresAt); cached(profile); return; }
  // Recorded before the probe, so a crash or a failed probe is never repeated for this expiry.
  if (!await saveCache(profile, { probedForExpiresAt: expiresAt, nextAllowedAt: clock() + minimumSeconds })) { expiredReport(profile, expiresAt); cached(profile); return; }
  await claudeProbe(profile, true);
  if (!await fetchClaudeUsage(profile)) cached(profile);
}

async function claudeUsage(profile, autoProbe) {
  // A per-profile lock covers the read/reserve step across status, watch and pick-profile.
  // The reservation survives process exit; a crashed lock expires after the fetch timeout.
  try { mkdirSync(join(home, runs), { recursive: true }); }
  catch { usageFail(profile, "cache directory unavailable"); cached(profile); return; }
  const lock = cachePath + "." + profile + ".lock";
  let fd;
  try {
    try { if (Date.now() - statSync(lock).mtimeMs > 30000) unlinkSync(lock); } catch {}
    fd = openSync(lock, "wx", 0o600);
  } catch { cached(profile); return; }
  try {
    const oauth = readOauth(profile);
    if (oauth && typeof oauth.accessToken === "string" && oauth.accessToken !== "" && typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) {
      await expiredToken(profile, oauth.expiresAt, autoProbe);
      return;
    }
    const entry = loadCache()[profile];
    if (!quotaCacheDecision(entry, clock()).call) { cached(profile); return; }
    if (!await saveCache(profile, { nextAllowedAt: clock() + minimumSeconds })) { cached(profile); return; }
    const success = await fetchClaudeUsage(profile);
    if (!success) cached(profile);
  } finally { closeSync(fd); unlinkSync(lock); }
}

async function fetchClaudeUsage(profile) {
  let oauth;
  try {
    const raw = JSON.parse(readFileSync(join(home, ".claude-profiles", profile, ".credentials.json"), "utf8"));
    oauth = raw && raw.claudeAiOauth;
  } catch { return usageFail(profile, "no readable credentials"); }
  if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken === "") return usageFail(profile, "no access token");
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) return expiredReport(profile, oauth.expiresAt);
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: { Authorization: "Bearer " + oauth.accessToken, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "omi-coordinator-quota" },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { return usageFail(profile, e && e.name === "TimeoutError" ? "timeout" : "network error"); }
  if (!res.ok) {
    if (res.status === 429) await saveCache(profile, { nextAllowedAt: quotaRetryAt(res.headers?.get("retry-after") ?? null, clock(), minimumSeconds) });
    return usageFail(profile, "HTTP " + res.status);
  }
  let body;
  try { body = await res.json(); } catch { return usageFail(profile, "response is not JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return usageFail(profile, "unexpected response shape");
  // Forward only the fields the parser reads.
  const win = (w) => (w && typeof w === "object" ? { utilization: w.utilization, resets_at: w.resets_at } : null);
  const limits = Array.isArray(body.limits)
    ? body.limits.map((l) => {
        const m = l && l.scope && l.scope.model;
        return l && typeof l === "object"
          ? { kind: l.kind, percent: l.percent, resets_at: l.resets_at, model: m && typeof m.display_name === "string" ? m.display_name : null }
          : null;
      })
    : null;
  const usage = { five_hour: win(body.five_hour), seven_day: win(body.seven_day), limits };
  try {
    const reading = parseClaudeUsage(usage, clock());
    await saveCache(profile, { reading });
    emit({ kind: "usage", profile, usage });
    return true;
  } catch { usageFail(profile, "unexpected response shape"); }
}

emit({ kind: "now", now: Math.floor(Date.now() / 1000) });
logs();
const jobs = targets.map(async (t) => {
  const [tool, profile] = t.split(":");
  if (tool === "codex") return codex(profile);
  await claudeUsage(profile, probe === "expired");
  if (probe === "1") await claudeProbe(profile, false);
});
await Promise.all(jobs);
`;
