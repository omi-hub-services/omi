import { describe, expect, it } from "vitest";
import {
  evaluateQuota,
  quotaSeverity,
  type QuotaReading,
  type QuotaThresholds,
} from "../../../../src/domain/profiles/quota-policy.ts";

const T = { minFiveHourLeftPercent: 10, minSevenDayLeftPercent: 20 };
const sev = (five: number | null, seven: number | null, limited = false) =>
  quotaSeverity({ fiveHourLeft: five, sevenDayLeft: seven, limited }, T);

describe("quotaSeverity (one rule for every watch source)", () => {
  it("is unknown when neither window was read, even if a limit is reported", () => {
    expect(sev(null, null)).toBe("unknown");
    expect(sev(null, null, true)).toBe("unknown");
  });

  it("is ok at or above both thresholds", () => {
    expect(sev(10, 20)).toBe("ok");
    expect(sev(100, null)).toBe("ok");
    expect(sev(null, 55)).toBe("ok");
  });

  it("is low under a threshold but not under half of it", () => {
    expect(sev(9.9, 90)).toBe("low");
    expect(sev(5, 90)).toBe("low");
    expect(sev(90, 19)).toBe("low");
    expect(sev(90, 10)).toBe("low");
  });

  it("is critical under half a threshold, using each window's own threshold", () => {
    expect(sev(4.9, 90)).toBe("critical");
    expect(sev(90, 9.9)).toBe("critical");
    expect(sev(0, null)).toBe("critical");
  });

  it("is critical when the provider limit is reached, whatever is left", () => {
    expect(sev(80, 80, true)).toBe("critical");
  });
});

describe("evaluateQuota carries the five-hour reset for display", () => {
  const thresholds: QuotaThresholds = {
    minFiveHourLeftPercent: 10,
    minSevenDayLeftPercent: 10,
    coordinatorSharedPenalty: 20,
    coordinatorSharedPolicy: "penalize",
    staleAfterMs: 7_200_000,
  };
  const reading = (resetsAt: number | null): QuotaReading => ({
    source: "codex-app-server",
    observedAt: 1000,
    fiveHour: { usedPercent: 50, resetsAt },
    sevenDay: null,
    status: null,
    limited: false,
    resetCredits: null,
    modelWindows: [],
  });
  const verdict = (r: QuotaReading | null) =>
    evaluateQuota(
      { profileId: "p", sharesCoordinatorAccount: false, reading: r },
      thresholds,
      2000,
    );

  it("is the window's reset while it is still to come", () => {
    expect(verdict(reading(9000)).fiveHourResetsAt).toBe(9000);
  });

  it("is null when it is unknown, already past, or nothing was read", () => {
    expect(verdict(reading(null)).fiveHourResetsAt).toBeNull();
    expect(verdict(reading(2000)).fiveHourResetsAt).toBeNull();
    expect(verdict(null).fiveHourResetsAt).toBeNull();
  });
});
