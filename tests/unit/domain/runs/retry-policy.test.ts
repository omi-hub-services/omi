import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  decideOperationalRetry,
} from "../../../../src/domain/runs/retry-policy.ts";
import type { RetryInput } from "../../../../src/domain/runs/retry-policy.ts";

const budget = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 };
const input = (overrides: Partial<RetryInput> = {}): RetryInput => ({
  failure: "network",
  retriesMade: 0,
  now: 10_000,
  jitter: 0,
  budget,
  ...overrides,
});

describe("backoffDelayMs", () => {
  it("doubles each retry and caps at the maximum", () => {
    expect([0, 1, 2, 3, 4].map((n) => backoffDelayMs(n, 0.999999, budget))).toEqual([
      999, 1999, 3999, 7999, 7999,
    ]);
  });

  it("uses equal jitter: at least half the delay, below the full delay", () => {
    expect(backoffDelayMs(2, 0, budget)).toBe(2000);
    expect(backoffDelayMs(2, 0.5, budget)).toBe(3000);
    expect(backoffDelayMs(2, 5, budget)).toBeLessThan(4000);
    expect(backoffDelayMs(2, -1, budget)).toBe(2000);
  });
});

describe("decideOperationalRetry", () => {
  it("retries a network failure no earlier than the backoff, computed from the passed time", () => {
    expect(decideOperationalRetry(input())).toEqual({ action: "retry", notBefore: 10_500 });
    expect(decideOperationalRetry(input({ retriesMade: 2 }))).toEqual({
      action: "retry",
      notBefore: 12_000,
    });
  });

  it("stops when the retry budget is spent, at the boundary", () => {
    expect(decideOperationalRetry(input({ retriesMade: 2 })).action).toBe("retry");
    expect(decideOperationalRetry(input({ retriesMade: 3 }))).toEqual({
      action: "stop",
      reason: "RETRY_BUDGET_EXHAUSTED",
    });
  });

  it("fails over on a rate limit with the tool's real cooldown when known, else a backoff", () => {
    expect(decideOperationalRetry(input({ failure: "rate_limit", cooldownUntil: 99_000 }))).toEqual(
      {
        action: "failover",
        cooldownUntil: 99_000,
      },
    );
    expect(decideOperationalRetry(input({ failure: "rate_limit" }))).toEqual({
      action: "failover",
      cooldownUntil: 10_500,
    });
  });

  it("never reports a cooldown that already ended", () => {
    expect(decideOperationalRetry(input({ failure: "rate_limit", cooldownUntil: 5_000 }))).toEqual({
      action: "failover",
      cooldownUntil: 10_500,
    });
  });

  it("never retries login or config problems, and never guesses an unclassified failure", () => {
    expect(decideOperationalRetry(input({ failure: "login_required" }))).toEqual({
      action: "stop",
      reason: "LOGIN_REQUIRED",
    });
    expect(decideOperationalRetry(input({ failure: "invalid_config" }))).toEqual({
      action: "stop",
      reason: "INVALID_CONFIG",
    });
    expect(decideOperationalRetry(input({ failure: "unclassified" }))).toEqual({
      action: "stop",
      reason: "UNCLASSIFIED_FAILURE",
    });
  });

  it("reconciles before repeating a call whose remote outcome is unknown, even with budget spent", () => {
    expect(
      decideOperationalRetry(input({ failure: "remote_outcome_unknown", retriesMade: 99 })),
    ).toEqual({ action: "reconcile_first" });
  });

  it("recovers a dead process before dispatching again", () => {
    expect(decideOperationalRetry(input({ failure: "process_died" }))).toEqual({
      action: "recover",
    });
  });
});
