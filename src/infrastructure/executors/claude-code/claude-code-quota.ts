import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  QuotaProfileRef,
  QuotaReader,
  QuotaReadResult,
} from "../../../application/ports/quota-reader.js";
import {
  decideExpiryProbe,
  EXPIRY_PROBE_COOLDOWN_MS,
  type ModelQuotaWindow,
  type QuotaReading,
  type QuotaWindow,
} from "../../../domain/profiles/quota-policy.js";
import { readBoundedText } from "../../processes/read-bounded-text.js";
import { startSupervisedProcess } from "../../processes/supervised-process.js";
import { buildClaudeCodeEnvironment } from "./claude-code-environment.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FETCH_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 120_000;
/** The endpoint is undocumented: never call a profile more often than this (ADR-0033). */
const DEFAULT_MIN_INTERVAL_MS = 300_000;

const credentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string(),
    expiresAt: z.number().optional(),
  }),
});

const percent = z.number();
const usageWindowSchema = z
  .object({ utilization: percent, resets_at: z.string().nullable().optional() })
  .nullable()
  .optional();
const usageSchema = z.object({
  five_hour: usageWindowSchema,
  seven_day: usageWindowSchema,
  limits: z.array(z.unknown()).optional(),
});
const scopedLimitSchema = z.object({
  kind: z.literal("weekly_scoped"),
  percent,
  resets_at: z.string().nullable().optional(),
  scope: z.object({ model: z.object({ display_name: z.string().min(1) }) }),
});

const round1 = (n: number) => Math.round(n * 10) / 10;
const isoMs = (value: string | null | undefined): number | null => {
  const ms = value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Pure parse of the `/api/oauth/usage` body (ADR-0033). Only `five_hour`, `seven_day` and the
 * `weekly_scoped` entries survive; every other key is dropped. Throws when neither window is
 * readable, so the caller falls back to the last reading.
 */
export function parseClaudeUsage(body: unknown, observedAt: number): QuotaReading {
  const usage = usageSchema.parse(body);
  const window = (w: z.infer<typeof usageWindowSchema>): QuotaWindow | null =>
    w === null || w === undefined
      ? null
      : { usedPercent: round1(w.utilization), resetsAt: isoMs(w.resets_at) };
  const fiveHour = window(usage.five_hour);
  const sevenDay = window(usage.seven_day);
  if (fiveHour === null && sevenDay === null) throw new Error("no window");
  const modelWindows = (usage.limits ?? []).flatMap((entry): ModelQuotaWindow[] => {
    const parsed = scopedLimitSchema.safeParse(entry);
    return parsed.success
      ? [
          {
            model: parsed.data.scope.model.display_name,
            usedPercent: round1(parsed.data.percent),
            resetsAt: isoMs(parsed.data.resets_at),
          },
        ]
      : [];
  });
  const full = [fiveHour, sevenDay].some((w) => w !== null && w.usedPercent >= 100);
  return {
    source: "claude-usage-api",
    observedAt,
    fiveHour,
    sevenDay,
    status: full ? "rejected" : "allowed",
    limited: full,
    resetCredits: null,
    modelWindows,
  };
}

const unifiedSchema = z.object({
  rate_limit_info: z.object({
    status: z.string().nullable().optional(),
    unifiedWindows: z.object({
      five_hour: z
        .object({ utilization: percent, resetsAt: z.number().nullable().optional() })
        .optional(),
      seven_day: z
        .object({ utilization: percent, resetsAt: z.number().nullable().optional() })
        .optional(),
    }),
  }),
});

/** A stream-json `rate_limit_event` line; `utilization` is 0-1 here and `resetsAt` unix seconds. */
export function parseClaudeRateLimitEvent(event: unknown, observedAt: number): QuotaReading {
  const info = unifiedSchema.parse(event).rate_limit_info;
  const window = (
    w: { utilization: number; resetsAt?: number | null | undefined } | undefined,
  ): QuotaWindow | null =>
    w === undefined
      ? null
      : {
          usedPercent: round1(w.utilization * 100),
          resetsAt: w.resetsAt === null || w.resetsAt === undefined ? null : w.resetsAt * 1000,
        };
  const fiveHour = window(info.unifiedWindows.five_hour);
  const sevenDay = window(info.unifiedWindows.seven_day);
  if (fiveHour === null && sevenDay === null) throw new Error("no window");
  return {
    source: "claude-probe",
    observedAt,
    fiveHour,
    sevenDay,
    status: info.status ?? null,
    limited: info.status === "rejected",
    resetCredits: null,
    modelWindows: [],
  };
}

/** Unix-ms retry time from `Retry-After` (delta seconds or HTTP date), at least `minimumMs` away. */
function retryAt(header: string | null | undefined, now: number, minimumMs: number): number {
  const value = header?.trim() ?? "";
  const requested = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Math.max(now + minimumMs, Number.isFinite(requested) ? requested : 0);
}

export interface ClaudeQuotaProbeOptions {
  readonly executable: string;
  readonly parentEnv: NodeJS.ProcessEnv;
}

export interface ClaudeQuotaReaderOptions {
  readonly fetch?: typeof fetch;
  readonly minIntervalMs?: number;
  /** Absent: `probe: true` reads like any other call. Present: one Haiku call per probe. */
  readonly probe?: ClaudeQuotaProbeOptions;
}

interface ProfileState {
  last: QuotaReading | undefined;
  nextAllowedAt: number;
  lastProbeAt: number | null;
  probedForExpiresAt: number | null;
}

/** The newest `rate_limit_event` in a probe's stdout, or undefined. */
function lastRateLimitEvent(lines: readonly string[]): unknown {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || !line.includes("rate_limit_event")) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown };
      if (event.type === "rate_limit_event") return event;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function runProbe(probe: ClaudeQuotaProbeOptions, profileHome: string): Promise<unknown> {
  const lines: string[] = [];
  try {
    const process = await startSupervisedProcess({
      executable: probe.executable,
      args: [
        "-p",
        "--model",
        "haiku",
        "--max-turns",
        "1",
        "--tools",
        "",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      cwd: tmpdir(),
      env: buildClaudeCodeEnvironment(probe.parentEnv, profileHome),
      stdin: "reply ok",
      onStdoutLine: (line) => lines.push(line),
      timeoutMs: PROBE_TIMEOUT_MS,
      graceMs: 2000,
      maxStdoutChars: 1_000_000,
      maxLineChars: 1_000_000,
      maxStderrChars: 16_000,
    });
    await process.exit;
  } catch {
    return undefined;
  }
  return lastRateLimitEvent(lines);
}

/**
 * Claude quota from the profile's own OAuth usage endpoint (ADR-0033, ADR-0023). The access token
 * lives in a local variable for one request: it goes only to api.anthropic.com (redirects are
 * errors), and no error text, note or reading carries it. It is never refreshed and nothing is
 * written to the profile directory. Failures fall back to the last good reading in memory, which
 * keeps its original `observedAt` so the policy marks it stale. shortcut: the fallback cache is
 * per process; a persisted cache or worker-log fallback comes with the runtime status work.
 */
export function createClaudeQuotaReader(options: ClaudeQuotaReaderOptions = {}): QuotaReader {
  const doFetch = options.fetch ?? fetch;
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const states = new Map<string, ProfileState>();

  async function readOauth(
    profile: QuotaProfileRef,
  ): Promise<z.infer<typeof credentialsSchema>["claudeAiOauth"] | undefined> {
    const text = await readBoundedText(join(profile.credentialRef, ".credentials.json"), 64_000);
    try {
      return credentialsSchema.parse(JSON.parse(text ?? "")).claudeAiOauth;
    } catch {
      return undefined;
    }
  }

  /** One probe; keeps the last good model windows and starts the shared cooldown. */
  async function probeProfile(
    probe: ClaudeQuotaProbeOptions,
    profile: QuotaProfileRef,
    state: ProfileState,
    now: number,
  ): Promise<QuotaReadResult> {
    state.lastProbeAt = now;
    const event = await runProbe(probe, profile.credentialRef);
    try {
      if (event === undefined) throw new Error("no event");
      // A probe does not report per-model windows: keep the last known ones.
      state.last = {
        ...parseClaudeRateLimitEvent(event, now),
        modelWindows: state.last?.modelWindows ?? [],
      };
      return { reading: state.last, note: null };
    } catch {
      return { reading: state.last ?? null, note: "probe returned no rate_limit_event" };
    }
  }

  async function usage(
    profile: QuotaProfileRef,
    state: ProfileState,
    now: number,
  ): Promise<QuotaReadResult> {
    const stale = (note: string | null): QuotaReadResult => ({
      reading: state.last ?? null,
      note,
    });
    let oauth = await readOauth(profile);
    if (oauth === undefined) return stale("no readable credentials");
    if (oauth.accessToken === "") return stale("no access token");
    const expiresAt = oauth.expiresAt ?? null;
    if (expiresAt !== null && expiresAt <= now) {
      // The token renews only when claude runs on the profile: one probe renews it (ADR-0033).
      const decision = decideExpiryProbe({
        expiresAt,
        now,
        lastProbeAt: state.lastProbeAt,
        probedForExpiresAt: state.probedForExpiresAt,
        cooldownMs: EXPIRY_PROBE_COOLDOWN_MS,
      });
      if (options.probe !== undefined && decision.probe) {
        state.probedForExpiresAt = expiresAt;
        await probeProfile(options.probe, profile, state, now);
        oauth = await readOauth(profile);
      }
      if (oauth === undefined || (oauth.expiresAt !== undefined && oauth.expiresAt <= now))
        return stale("token expired");
    }
    if (now < state.nextAllowedAt) return stale(null);
    state.nextAllowedAt = now + minInterval;
    let response: Response;
    try {
      response = await doFetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "omi-squad-quota",
        },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      // The exception text is dropped: it could echo request details, including the header.
      return stale(
        error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error",
      );
    }
    if (!response.ok) {
      if (response.status === 429) {
        state.nextAllowedAt = retryAt(response.headers.get("retry-after"), now, minInterval);
      }
      return stale(`HTTP ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return stale("response is not JSON");
    }
    try {
      state.last = parseClaudeUsage(body, now);
      return { reading: state.last, note: null };
    } catch {
      return stale("unexpected response shape");
    }
  }

  return {
    async read(profile, { now, probe }) {
      let state = states.get(profile.credentialRef);
      if (state === undefined) {
        state = { last: undefined, nextAllowedAt: 0, lastProbeAt: null, probedForExpiresAt: null };
        states.set(profile.credentialRef, state);
      }
      if (probe && options.probe !== undefined) {
        return probeProfile(options.probe, profile, state, now);
      }
      return usage(profile, state, now);
    },
  };
}
