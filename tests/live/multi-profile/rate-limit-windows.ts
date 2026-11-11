// OMI-004 live support: read every quota window a Claude Code `rate_limit_event` reports.
// Test-only. The production stream parser (src/infrastructure/executors/claude-code/) keeps
// only status, limit type and reset time; this module keeps every window so the PoC can record
// which windows exist (five_hour, seven_day, any per-model window) and their utilization.
import { z } from "zod";

const windowSchema = z.looseObject({
  utilization: z.number().nonnegative().optional(),
  status: z.string().min(1).max(64).optional(),
  /** Epoch seconds. */
  resetsAt: z.number().int().nonnegative().optional(),
});

const rateLimitInfoSchema = z.looseObject({
  status: z.string().min(1).max(64),
  rateLimitType: z.string().min(1).max(64).optional(),
  resetsAt: z.number().int().nonnegative().optional(),
  overageStatus: z.string().min(1).max(64).optional(),
  isUsingOverage: z.boolean().optional(),
  unifiedWindows: z.record(z.string().min(1).max(64), windowSchema).optional(),
});

export interface QuotaWindow {
  /** Key under `unifiedWindows`, e.g. `five_hour`, `seven_day`, `seven_day_overage_included`. */
  name: string;
  utilization?: number;
  status?: string;
  resetsAt?: number;
}

export interface QuotaObservation {
  status: string;
  /** The window the CLI named as the binding one for this event. */
  rateLimitType?: string;
  resetsAt?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  windows: QuotaWindow[];
}

/** Window keys that are account-wide; anything else is reported as a possible per-model window. */
export const ACCOUNT_WIDE_WINDOWS: readonly string[] = [
  "five_hour",
  "seven_day",
  "seven_day_overage_included",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one stream-json event. Returns `undefined` for any other event type and for a
 * `rate_limit_event` whose `rate_limit_info` does not validate (drift is reported by the caller
 * as "no observation", never guessed). Only numbers, short status strings and window names are
 * kept: the event carries no secret, but nothing else is copied either.
 */
export function parseRateLimitEvent(event: unknown): QuotaObservation | undefined {
  if (!isRecord(event) || event["type"] !== "rate_limit_event") return undefined;
  const parsed = rateLimitInfoSchema.safeParse(event["rate_limit_info"]);
  if (!parsed.success) return undefined;
  const info = parsed.data;
  const windows = Object.entries(info.unifiedWindows ?? {})
    .map(([name, window]): QuotaWindow => {
      return {
        name,
        ...(window.utilization === undefined ? {} : { utilization: window.utilization }),
        ...(window.status === undefined ? {} : { status: window.status }),
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    status: info.status,
    ...(info.rateLimitType === undefined ? {} : { rateLimitType: info.rateLimitType }),
    ...(info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt }),
    ...(info.overageStatus === undefined ? {} : { overageStatus: info.overageStatus }),
    ...(info.isUsingOverage === undefined ? {} : { isUsingOverage: info.isUsingOverage }),
    windows,
  };
}

/** All observations in a run, in stream order. */
export function collectQuotaObservations(events: readonly unknown[]): QuotaObservation[] {
  const observations: QuotaObservation[] = [];
  for (const event of events) {
    const observation = parseRateLimitEvent(event);
    if (observation !== undefined) observations.push(observation);
  }
  return observations;
}

/** Window names outside the known account-wide set, e.g. a weekly per-model window. */
export function perModelWindowNames(observations: readonly QuotaObservation[]): string[] {
  const names = new Set<string>();
  for (const observation of observations) {
    for (const window of observation.windows) {
      if (!ACCOUNT_WIDE_WINDOWS.includes(window.name)) names.add(window.name);
    }
  }
  return [...names].sort();
}

/** True when any observation reports a rejection (the real-quota signal, not an injected one). */
export function isRejected(observations: readonly QuotaObservation[]): boolean {
  return observations.some(
    (observation) =>
      observation.status === "rejected" ||
      observation.windows.some((window) => window.status === "rejected"),
  );
}
