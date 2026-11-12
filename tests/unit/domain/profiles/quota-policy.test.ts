import { describe, expect, it } from "vitest";
import {
  compareQuota,
  earliestQuotaReset,
  evaluateQuota,
  type QuotaReading,
  type QuotaThresholds,
} from "../../../../src/domain/profiles/quota-policy.ts";

const HOUR = 3_600_000;
const now = 1_800_000_000_000;
const thresholds: QuotaThresholds = {
  minFiveHourLeftPercent: 10,
  minSevenDayLeftPercent: 10,
  coordinatorSharedPenalty: 20,
  coordinatorSharedPolicy: "penalize",
  staleAfterMs: 2 * HOUR,
};

function reading(over: Partial<QuotaReading> = {}): QuotaReading {
  return {
    source: "claude-usage-api",
    observedAt: now - 60_000,
    fiveHour: { usedPercent: 30, resetsAt: now + HOUR },
    sevenDay: { usedPercent: 40, resetsAt: now + 48 * HOUR },
    status: "allowed",
    limited: false,
    resetCredits: null,
    modelWindows: [],
    ...over,
  };
}
const subject = (profileId: string, r: QuotaReading | null, shared = false) => ({
  profileId,
  sharesCoordinatorAccount: shared,
  reading: r,
});
const verdict = (profileId: string, r: QuotaReading | null, shared = false) =>
  evaluateQuota(subject(profileId, r, shared), thresholds, now);

describe("quota policy: score", () => {
  it("scores a profile by the tighter of the two windows", () => {
    const v = verdict("a", reading());
    expect(v).toMatchObject({ fiveHourLeft: 70, sevenDayLeft: 60, score: 60, blocked: [] });
  });
  it("takes the Coordinator penalty off a profile that shares the Coordinator account", () => {
    expect(verdict("a", reading(), true).score).toBe(40);
  });
  it("treats a window whose reset time has passed as full again", () => {
    const v = verdict("a", reading({ fiveHour: { usedPercent: 99, resetsAt: now - 1 } }));
    expect(v).toMatchObject({ fiveHourLeft: 100, blocked: [] });
  });
});

describe("quota policy: thresholds", () => {
  it("blocks below the 5h threshold and reports when that window resets", () => {
    const resetsAt = now + 30 * 60_000;
    const v = verdict("a", reading({ fiveHour: { usedPercent: 95, resetsAt } }));
    expect(v.blocked).toEqual(["FIVE_HOUR_BELOW_THRESHOLD"]);
    expect(v.blockedUntil).toBe(resetsAt);
  });
  it("blocks until the last blocking window has reset", () => {
    const v = verdict(
      "a",
      reading({
        fiveHour: { usedPercent: 95, resetsAt: now + HOUR },
        sevenDay: { usedPercent: 99, resetsAt: now + 30 * HOUR },
      }),
    );
    expect(v.blocked).toEqual(["FIVE_HOUR_BELOW_THRESHOLD", "SEVEN_DAY_BELOW_THRESHOLD"]);
    expect(v.blockedUntil).toBe(now + 30 * HOUR);
  });
  it("stays allowed exactly at the threshold", () => {
    expect(
      verdict("a", reading({ fiveHour: { usedPercent: 90, resetsAt: now + HOUR } })).blocked,
    ).toEqual([]);
  });
  it("blocks a reported limit with no reset time and cannot say when it clears", () => {
    const v = verdict(
      "a",
      reading({ fiveHour: null, sevenDay: null, limited: true, status: "rejected" }),
    );
    expect(v.blocked).toEqual(["LIMIT_REACHED"]);
    expect(v.blockedUntil).toBeNull();
  });
  it("ignores an old limit whose windows have all reset", () => {
    const old = { usedPercent: 100, resetsAt: now - HOUR };
    expect(verdict("a", reading({ fiveHour: old, sevenDay: old, limited: true })).blocked).toEqual(
      [],
    );
  });
  it("blocks only the model whose own weekly window is below the 7d threshold", () => {
    const v = verdict(
      "a",
      reading({ modelWindows: [{ model: "Opus", usedPercent: 97, resetsAt: now + 5 * HOUR }] }),
    );
    expect(v.blocked).toEqual([]);
    expect(v.modelWindows).toEqual([
      { model: "opus", left: 3, blocked: true, resetsAt: now + 5 * HOUR },
    ]);
  });
});

describe("quota policy: Coordinator account", () => {
  it("forbids a profile that shares the Coordinator account when the config forbids it", () => {
    const v = evaluateQuota(
      subject("a", reading(), true),
      { ...thresholds, coordinatorSharedPolicy: "forbid" },
      now,
    );
    expect(v.blocked).toEqual(["SHARES_COORDINATOR_ACCOUNT"]);
    expect(v.blockedUntil).toBeNull();
  });
  it("does not forbid a profile that does not share the Coordinator account", () => {
    const v = evaluateQuota(
      subject("a", reading(), false),
      { ...thresholds, coordinatorSharedPolicy: "forbid" },
      now,
    );
    expect(v.blocked).toEqual([]);
  });
});

describe("quota policy: freshness and missing data", () => {
  it("marks an old reading stale", () => {
    expect(verdict("a", reading({ observedAt: now - 3 * HOUR })).freshness).toBe("stale");
    expect(verdict("a", reading()).freshness).toBe("fresh");
  });
  it("keeps a profile with no reading usable but unknown and unscored", () => {
    expect(verdict("a", null)).toMatchObject({
      freshness: "unknown",
      score: null,
      blocked: [],
    });
  });
});

describe("quota policy: ranking", () => {
  it("ranks fresh before stale before unknown, then by score, then by id", () => {
    const stale = verdict("stale-high", reading({ observedAt: now - 3 * HOUR }));
    const unknown = verdict("unknown", null);
    const low = verdict("fresh-low", reading({ sevenDay: { usedPercent: 70, resetsAt: null } }));
    const high = verdict("fresh-high", reading());
    const tie = verdict("a-tie", reading());
    const ranked = [stale, unknown, low, high, tie].sort(compareQuota).map((v) => v.profileId);
    expect(ranked).toEqual(["a-tie", "fresh-high", "fresh-low", "stale-high", "unknown"]);
  });
});

describe("quota policy: reset credits", () => {
  it("reports Codex reset credits but never lets them lift a block", () => {
    const v = verdict(
      "codex",
      reading({
        source: "codex-app-server",
        fiveHour: { usedPercent: 100, resetsAt: now + HOUR },
        resetCredits: 2,
      }),
    );
    expect(v.blocked).toEqual(["FIVE_HOUR_BELOW_THRESHOLD"]);
    expect(v.resetCredits).toBe(2);
    expect(v.blockedUntil).toBe(now + HOUR);
  });
});

describe("quota policy: earliest reset", () => {
  it("is the soonest time any blocked profile clears", () => {
    const a = verdict("a", reading({ fiveHour: { usedPercent: 99, resetsAt: now + 3 * HOUR } }));
    const b = verdict("b", reading({ fiveHour: { usedPercent: 99, resetsAt: now + HOUR } }));
    expect(earliestQuotaReset([a, b])).toBe(now + HOUR);
  });
  it("skips a profile with no known reset and is null when none is known", () => {
    const unknown = verdict("u", reading({ fiveHour: null, sevenDay: null, limited: true }));
    const known = verdict("k", reading({ fiveHour: { usedPercent: 99, resetsAt: now + HOUR } }));
    expect(earliestQuotaReset([unknown, known])).toBe(now + HOUR);
    expect(earliestQuotaReset([unknown])).toBeNull();
  });
});
