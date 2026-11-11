// Pure conversion of the worker and quota reads into the JSON the web watch page shows
// (OMI-067, ADR-0014). Colour rules and thresholds come from watch-core.ts, shared with the
// terminal watch. Strings from outside are stripped of control characters here and rendered only
// through `textContent` by the page.
import type { QuotaSettings, WorkerProfile } from "./coordinator-settings.ts";
import { localTime, windowLeft, type QuotaReport, type QuotaWindow } from "./quota.ts";
import { clean, STALE_AFTER_SECONDS, windowsLow, workerTone, type Tone } from "./watch-core.ts";
import type { Workers } from "./wsl-workers.ts";

export interface WorkerView {
  readonly pid: number;
  readonly task: string;
  readonly tool: "claude" | "codex";
  readonly profile: string;
  readonly model: string;
  readonly effort: string;
  readonly elapsedSeconds: number;
  /** null when the worker log could not be read. */
  readonly turns: number | null;
  readonly lastAction: string;
  readonly tone: Tone;
}

export type WorkersView =
  | { readonly state: "loading" }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "ok"; readonly items: readonly WorkerView[] };

export interface WindowView {
  /** Share (%) left; null when unknown. */
  readonly left: number | null;
  /** Below the pick-profile threshold: shown yellow. */
  readonly low: boolean;
  /** Local reset time (5h: `HH:MM`, otherwise `MM-DD HH:MM`); null when unknown or already past. */
  readonly resetText: string | null;
}

export interface ModelView {
  readonly model: string;
  readonly left: number;
  readonly resetText: string | null;
}

export interface ReadingView {
  readonly source: string;
  readonly observedAt: number;
  /** Age at `generatedAt`; the page adds the time since it received the snapshot. */
  readonly ageSeconds: number;
  readonly fiveHour: WindowView | null;
  readonly sevenDay: WindowView | null;
  readonly models: readonly ModelView[];
  readonly limited: boolean;
  /** Either window is below its threshold. */
  readonly low: boolean;
}

export interface ProfileView {
  readonly tool: "claude" | "codex";
  readonly profile: string;
  readonly reading: ReadingView | null;
  /** Why there is no reading, or the usage-endpoint fallback note. */
  readonly note: string | null;
}

export interface QuotaView {
  readonly state: "loading" | "unavailable" | "ok";
  readonly reason: string | null;
  readonly profiles: readonly ProfileView[];
}

export interface WatchSnapshot {
  /** Unix seconds. */
  readonly generatedAt: number;
  /** A reading older than this is shown dim. */
  readonly staleAfterSeconds: number;
  readonly probing: boolean;
  readonly workers: WorkersView;
  readonly quota: QuotaView;
}

export interface SnapshotInput {
  readonly workers: Workers | null;
  readonly quota: QuotaReport | null;
  readonly probing: boolean;
  /** Unix seconds. */
  readonly now: number;
  readonly settings: QuotaSettings;
  readonly profiles: readonly WorkerProfile[];
}

const orDash = (s: string | null | undefined) => clean(s ?? "") || "-";

function resetText(resetsAt: number | null | undefined, now: number, clockOnly: boolean) {
  if (resetsAt === null || resetsAt === undefined || !Number.isFinite(resetsAt)) return null;
  if (resetsAt <= now) return null;
  const local = localTime(resetsAt);
  return clockOnly ? local.slice(11, 16) : local.slice(5, 16);
}

function windowView(
  w: QuotaWindow | null,
  now: number,
  clockOnly: boolean,
  minLeft: number,
): WindowView | null {
  if (w === null) return null;
  const left = windowLeft(w, now);
  return {
    left,
    low: left !== null && left < minLeft,
    resetText: resetText(w.resetsAt, now, clockOnly),
  };
}

export function buildSnapshot(input: SnapshotInput): WatchSnapshot {
  const { workers, quota, now, settings } = input;
  const workersView: WorkersView = !workers
    ? { state: "loading" }
    : !workers.available
      ? { state: "unavailable", reason: orDash(workers.reason) }
      : {
          state: "ok",
          items: workers.processes.map((p) => ({
            pid: p.pid,
            task: orDash(p.task),
            tool: p.tool,
            profile: orDash(p.profile),
            model: orDash(p.model),
            effort: orDash(p.effort),
            elapsedSeconds: Math.max(0, Math.floor(p.elapsedSeconds)),
            turns: p.log ? p.log.numTurns : null,
            lastAction: orDash(p.log?.lastAction),
            tone: workerTone(p.log),
          })),
        };

  const profiles = input.profiles.map((profile): ProfileView => {
    const base = { tool: profile.tool, profile: clean(profile.profile) };
    const entry = quota?.available
      ? quota.profiles.find((p) => p.tool === profile.tool && p.profile === profile.profile)
      : undefined;
    const r = entry?.reading;
    if (!r) {
      return {
        ...base,
        reading: null,
        note: clean(entry?.note ?? (quota ? "unavailable" : "loading")),
      };
    }
    const fiveHour = windowView(r.fiveHour, now, true, settings.minFiveHourLeftPercent);
    const sevenDay = windowView(r.sevenDay, now, false, settings.minSevenDayLeftPercent);
    return {
      ...base,
      note: entry.note === null ? null : clean(entry.note),
      reading: {
        source: r.source,
        observedAt: r.observedAt,
        ageSeconds: Math.max(0, now - r.observedAt),
        fiveHour,
        sevenDay,
        models: r.modelWindows.flatMap((w): ModelView[] => {
          const left = windowLeft(w, now);
          return left === null
            ? []
            : [{ model: clean(w.model), left, resetText: resetText(w.resetsAt, now, false) }];
        }),
        limited: r.limited,
        low: windowsLow(fiveHour?.left ?? null, sevenDay?.left ?? null, settings),
      },
    };
  });

  return {
    generatedAt: now,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    probing: input.probing,
    workers: workersView,
    quota: !quota
      ? { state: "loading", reason: null, profiles }
      : !quota.available
        ? { state: "unavailable", reason: orDash(quota.reason), profiles }
        : { state: "ok", reason: null, profiles },
  };
}
