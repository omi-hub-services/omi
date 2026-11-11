import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectQuotaObservations,
  isRejected,
  parseRateLimitEvent,
  perModelWindowNames,
} from "../../../live/multi-profile/rate-limit-windows.js";

const fixtureDir = resolve(import.meta.dirname, "../../../fixtures/executors/claude-code");
const lines = (name: string): unknown[] =>
  readFileSync(join(fixtureDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);

describe("rate_limit_event windows", () => {
  it("keeps every window of the recorded event with its utilization", () => {
    const [event] = lines("rate-limit-allowed-recorded.jsonl");
    expect(parseRateLimitEvent(event)).toEqual({
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1794395400,
      overageStatus: "rejected",
      isUsingOverage: false,
      windows: [
        { name: "five_hour", utilization: 0.1, status: "allowed", resetsAt: 1794395400 },
        { name: "seven_day", utilization: 0.68, status: "allowed", resetsAt: 1794387600 },
      ],
    });
  });

  it("finds the rejection in a limited run and ignores other event types", () => {
    const observations = collectQuotaObservations(lines("usage-limit.stream.jsonl"));
    expect(observations).toHaveLength(1);
    expect(isRejected(observations)).toBe(true);
    expect(isRejected(collectQuotaObservations(lines("success.stream.jsonl")))).toBe(false);
  });

  it("reports a window outside the account-wide set as a possible per-model window", () => {
    const event = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0.2 },
          seven_day: { utilization: 0.3 },
          seven_day_overage_included: { utilization: 0.3 },
          seven_day_example_model: { utilization: 1, status: "rejected" },
        },
      },
    };
    const observations = collectQuotaObservations([event]);
    expect(perModelWindowNames(observations)).toEqual(["seven_day_example_model"]);
    // A rejected window counts even when the event's own status is allowed.
    expect(isRejected(observations)).toBe(true);
  });

  it("returns no observation for a drifted shape instead of guessing", () => {
    expect(parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: "x" })).toBeUndefined();
    expect(
      parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { resetsAt: 1 } }),
    ).toBeUndefined();
    expect(
      parseRateLimitEvent({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: -1 } } },
      }),
    ).toBeUndefined();
    expect(parseRateLimitEvent({ type: "result" })).toBeUndefined();
  });
});
