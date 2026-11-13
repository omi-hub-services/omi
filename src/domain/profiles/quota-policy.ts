/**
 * Subscription quota policy (ADR-0033 ported to the framework). Pure: readings, thresholds and
 * the clock are passed in; nothing here reads a file, a token or the time. Times are epoch ms.
 * Codex reset credits are only reported. No rule here can spend one; that is the PO's decision.
 */
export interface QuotaWindow {
  readonly usedPercent: number;
  /** Epoch ms when the window resets; null when the tool did not say. */
  readonly resetsAt: number | null;
}

/** Weekly window scoped to one model (display name from the usage endpoint, e.g. "Opus"). */
export interface ModelQuotaWindow extends QuotaWindow {
  readonly model: string;
}

export interface QuotaReading {
  readonly source: "codex-app-server" | "claude-usage-api" | "claude-probe";
  /** Epoch ms when the numbers were current. A cached reading keeps its original time. */
  readonly observedAt: number;
  readonly fiveHour: QuotaWindow | null;
  readonly sevenDay: QuotaWindow | null;
  readonly status: string | null;
  /** The provider reports the limit as reached right now. */
  readonly limited: boolean;
  /** Codex free reset credits left; reported, never spent. */
  readonly resetCredits: number | null;
  readonly modelWindows: readonly ModelQuotaWindow[];
}

export interface QuotaThresholds {
  readonly minFiveHourLeftPercent: number;
  readonly minSevenDayLeftPercent: number;
  /** Score points taken from a profile that shares the Coordinator account. */
  readonly coordinatorSharedPenalty: number;
  /** `forbid` refuses such a profile as a worker; `penalize` only ranks it lower. */
  readonly coordinatorSharedPolicy: "penalize" | "forbid";
  readonly staleAfterMs: number;
}

export interface QuotaSubject {
  readonly profileId: string;
  readonly sharesCoordinatorAccount: boolean;
  readonly reading: QuotaReading | null;
}

export type QuotaBlock =
  | "FIVE_HOUR_BELOW_THRESHOLD"
  | "SEVEN_DAY_BELOW_THRESHOLD"
  | "LIMIT_REACHED"
  | "SHARES_COORDINATOR_ACCOUNT";

export interface QuotaVerdict {
  readonly profileId: string;
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly fiveHourLeft: number | null;
  readonly sevenDayLeft: number | null;
  /** Epoch ms the five-hour window resets, for display; null when unknown or already past. */
  readonly fiveHourResetsAt: number | null;
  /** Share left in the tighter window minus the Coordinator penalty; null without a reading. */
  readonly score: number | null;
  /** Empty when the profile may take a worker. */
  readonly blocked: readonly QuotaBlock[];
  /** When every blocking window has reset; null when nothing says (or it never clears). */
  readonly blockedUntil: number | null;
  readonly resetCredits: number | null;
  /** Per-model weekly windows, model names lower-cased for exact case-insensitive matching. */
  readonly modelWindows: readonly {
    readonly model: string;
    readonly left: number;
    readonly blocked: boolean;
    readonly resetsAt: number | null;
  }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Share (%) of a window left; a window whose reset time has passed is full again. */
function left(window: QuotaWindow | null, now: number): number | null {
  if (window === null) return null;
  if (window.resetsAt !== null && window.resetsAt <= now) return 100;
  return round1(Math.max(0, 100 - window.usedPercent));
}

/**
 * A profile with no reading stays usable, ranked last: the usage endpoint can fail for an idle
 * profile, and a limit that really is hit is still caught by the mid-run failover.
 */
export function evaluateQuota(
  subject: QuotaSubject,
  thresholds: QuotaThresholds,
  now: number,
): QuotaVerdict {
  const r = subject.reading;
  const forbidden =
    subject.sharesCoordinatorAccount && thresholds.coordinatorSharedPolicy === "forbid";
  if (r === null) {
    return {
      profileId: subject.profileId,
      freshness: "unknown",
      fiveHourLeft: null,
      sevenDayLeft: null,
      fiveHourResetsAt: null,
      score: null,
      blocked: forbidden ? ["SHARES_COORDINATOR_ACCOUNT"] : [],
      blockedUntil: null,
      resetCredits: null,
      modelWindows: [],
    };
  }
  const fiveHourLeft = left(r.fiveHour, now);
  const sevenDayLeft = left(r.sevenDay, now);
  const blocked: QuotaBlock[] = [];
  const resets: (number | null)[] = [];
  if (fiveHourLeft !== null && fiveHourLeft < thresholds.minFiveHourLeftPercent) {
    blocked.push("FIVE_HOUR_BELOW_THRESHOLD");
    resets.push(r.fiveHour?.resetsAt ?? null);
  }
  if (sevenDayLeft !== null && sevenDayLeft < thresholds.minSevenDayLeftPercent) {
    blocked.push("SEVEN_DAY_BELOW_THRESHOLD");
    resets.push(r.sevenDay?.resetsAt ?? null);
  }
  // A reported limit blocks only while a window is still to reset, or when nothing says when.
  if (r.limited && blocked.length === 0) {
    const pending = [r.fiveHour, r.sevenDay].flatMap((w) =>
      w?.resetsAt != null && w.resetsAt > now ? [w.resetsAt] : [],
    );
    const anyReset = [r.fiveHour, r.sevenDay].some((w) => w?.resetsAt != null);
    if (pending.length > 0 || !anyReset) {
      blocked.push("LIMIT_REACHED");
      resets.push(...(pending.length > 0 ? pending : [null]));
    }
  }
  const known = [fiveHourLeft, sevenDayLeft].filter((n): n is number => n !== null);
  const penalty = subject.sharesCoordinatorAccount ? thresholds.coordinatorSharedPenalty : 0;
  if (forbidden) blocked.push("SHARES_COORDINATOR_ACCOUNT");
  const blockedUntil =
    forbidden || resets.length === 0 || resets.some((t) => t === null)
      ? null
      : Math.max(...resets.filter((t): t is number => t !== null));
  return {
    profileId: subject.profileId,
    freshness: now - r.observedAt > thresholds.staleAfterMs ? "stale" : "fresh",
    fiveHourLeft,
    sevenDayLeft,
    fiveHourResetsAt:
      r.fiveHour?.resetsAt != null && r.fiveHour.resetsAt > now ? r.fiveHour.resetsAt : null,
    score: known.length === 0 ? null : round1(Math.min(...known) - penalty),
    blocked,
    blockedUntil,
    resetCredits: r.resetCredits,
    modelWindows: r.modelWindows.flatMap((w) => {
      const modelLeft = left(w, now);
      return modelLeft === null
        ? []
        : [
            {
              model: w.model.trim().toLowerCase(),
              left: modelLeft,
              blocked: modelLeft < thresholds.minSevenDayLeftPercent,
              resetsAt: w.resetsAt,
            },
          ];
    }),
  };
}

export type QuotaSeverity = "ok" | "low" | "critical" | "unknown";

/**
 * How a profile's quota reads on the watch, the one rule for every source: unknown when no window
 * was read; critical when the provider limit is reached or a window is under half its threshold;
 * low when a window is under its threshold; otherwise ok. A window not read never counts as low.
 */
export function quotaSeverity(
  reading: {
    readonly fiveHourLeft: number | null;
    readonly sevenDayLeft: number | null;
    readonly limited: boolean;
  },
  thresholds: Pick<QuotaThresholds, "minFiveHourLeftPercent" | "minSevenDayLeftPercent">,
): QuotaSeverity {
  const { fiveHourLeft: five, sevenDayLeft: seven } = reading;
  if (five === null && seven === null) return "unknown";
  const under = (value: number | null, min: number, factor: number) =>
    value !== null && value < min * factor;
  if (
    reading.limited ||
    under(five, thresholds.minFiveHourLeftPercent, 0.5) ||
    under(seven, thresholds.minSevenDayLeftPercent, 0.5)
  )
    return "critical";
  return under(five, thresholds.minFiveHourLeftPercent, 1) ||
    under(seven, thresholds.minSevenDayLeftPercent, 1)
    ? "low"
    : "ok";
}

export interface ExpiryProbeInput {
  /** Epoch ms the OAuth access token expires; null when the credentials do not say. */
  readonly expiresAt: number | null;
  readonly now: number;
  /** Epoch ms of the last probe of this profile, whoever ran it; null when none is recorded. */
  readonly lastProbeAt: number | null;
  /** The `expiresAt` the last expiry probe was run for; null when none was. */
  readonly probedForExpiresAt: number | null;
  readonly cooldownMs: number;
}

export interface ExpiryProbeDecision {
  readonly probe: boolean;
  readonly reason: "token-valid" | "already-probed" | "cooldown" | "expired";
}

/**
 * An expired OAuth token is renewed only when `claude` runs on the profile, so one probe (one Haiku
 * call, ADR-0033) renews it. At most one probe per expiry: a probe that failed or left the same
 * expiry in place is not repeated, and no probe runs inside the cooldown of any earlier probe.
 * Self-contained on purpose: the Coordinator's WSL collector embeds this function's source.
 */
export function decideExpiryProbe(input: ExpiryProbeInput): ExpiryProbeDecision {
  if (input.expiresAt === null || input.expiresAt > input.now)
    return { probe: false, reason: "token-valid" };
  if (input.probedForExpiresAt === input.expiresAt)
    return { probe: false, reason: "already-probed" };
  if (input.lastProbeAt !== null && input.now - input.lastProbeAt < input.cooldownMs)
    return { probe: false, reason: "cooldown" };
  return { probe: true, reason: "expired" };
}

const FRESHNESS_RANK = { fresh: 0, stale: 1, unknown: 2 } as const;

/** Fresh before stale before unknown, then higher score; 0 is a tie the caller may break. */
export function compareQuotaStanding(a: QuotaVerdict, b: QuotaVerdict): number {
  return (
    FRESHNESS_RANK[a.freshness] - FRESHNESS_RANK[b.freshness] ||
    (b.score ?? -Infinity) - (a.score ?? -Infinity)
  );
}

/** The standing, then id (deterministic). */
export function compareQuota(a: QuotaVerdict, b: QuotaVerdict): number {
  return compareQuotaStanding(a, b) || a.profileId.localeCompare(b.profileId);
}

/** Soonest time any blocked verdict clears; null when no blocked verdict has a known reset. */
export function earliestQuotaReset(blocked: readonly QuotaVerdict[]): number | null {
  const times = blocked.flatMap((v) => (v.blockedUntil === null ? [] : [v.blockedUntil]));
  return times.length === 0 ? null : Math.min(...times);
}
