import { describe, expect, it } from "vitest";
import { evaluateProfileAvailability } from "../../../../src/domain/profiles/availability-policy.ts";

// Regression for the runtime-composition e2e flake (OMI-078 investigation): WSL2 steps the wall
// clock back by 1-2 s. A fixture that stamped lastProbeAt at "now" then looked like a probe from
// the future, which is refused as PROBE_STALE (and shown as NOT_PROBED), so dispatch was
// NOT_PLANNABLE. The refusal is right; fixtures must stamp probes in the past.
const TTL = 3_600_000;
const profile = (lastProbeAt: number) => ({
  state: "ready" as const,
  lastProbeAt,
  activeWorkers: 0,
  maxConcurrency: 1,
});

describe("probe evidence and a wall clock that steps back", () => {
  const stampedAt = 1_794_454_000_000;
  const afterStepBack = stampedAt - 1_880;

  it("refuses a probe stamped at 'now' once the clock steps back (why fixtures must not do that)", () => {
    expect(evaluateProfileAvailability(profile(stampedAt), afterStepBack, TTL)).toMatchObject({
      allowed: false,
      reason: "PROBE_STALE",
    });
  });

  it("keeps a probe stamped a minute earlier usable across the same step back", () => {
    expect(evaluateProfileAvailability(profile(stampedAt - 60_000), afterStepBack, TTL)).toEqual({
      allowed: true,
    });
  });
});
