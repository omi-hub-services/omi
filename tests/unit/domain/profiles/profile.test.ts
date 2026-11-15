import { describe, expect, it } from "vitest";
import { evaluateProfileAvailability } from "../../../../src/domain/profiles/availability-policy.ts";
import type { ProfileObservation } from "../../../../src/domain/profiles/availability-policy.ts";
import {
  PROFILE_RULES,
  PROFILE_STATES,
  transitionProfile,
} from "../../../../src/domain/profiles/profile-state.ts";
import type { ProfileEvent } from "../../../../src/domain/profiles/profile-state.ts";

const NOW = 100_000;
const TTL = 60_000;
const obs = (overrides: Partial<ProfileObservation>): ProfileObservation => ({
  state: "ready",
  lastProbeAt: NOW - 1,
  activeWorkers: 0,
  maxConcurrency: 1,
  ...overrides,
});

describe("evaluateProfileAvailability", () => {
  it("allows a freshly probed ready profile with a free slot", () => {
    expect(evaluateProfileAvailability(obs({}), NOW, TTL)).toEqual({ allowed: true });
  });

  it.each([
    ["disabled", "PROFILE_DISABLED"],
    ["login-required", "LOGIN_REQUIRED"],
    ["unavailable", "PROFILE_UNAVAILABLE"],
    ["unknown", "NOT_PROBED"],
  ] as const)("refuses state %s with %s (unknown is never treated as ready)", (state, reason) => {
    expect(evaluateProfileAvailability(obs({ state }), NOW, TTL)).toMatchObject({
      allowed: false,
      reason,
    });
  });

  it("refuses a profile in an active cooldown, and an expired cooldown still needs a probe", () => {
    expect(
      evaluateProfileAvailability(obs({ state: "cooldown", cooldownUntil: NOW + 1 }), NOW, TTL),
    ).toMatchObject({ reason: "COOLDOWN_ACTIVE" });
    expect(
      evaluateProfileAvailability(obs({ state: "cooldown", cooldownUntil: NOW }), NOW, TTL),
    ).toMatchObject({ reason: "NOT_PROBED" });
  });

  it("treats a probe exactly one TTL old as stale and one millisecond newer as fresh", () => {
    expect(evaluateProfileAvailability(obs({ lastProbeAt: NOW - TTL }), NOW, TTL)).toMatchObject({
      reason: "PROBE_STALE",
    });
    expect(evaluateProfileAvailability(obs({ lastProbeAt: NOW - TTL + 1 }), NOW, TTL)).toEqual({
      allowed: true,
    });
    expect(
      evaluateProfileAvailability(
        { state: "ready", activeWorkers: 0, maxConcurrency: 1 },
        NOW,
        TTL,
      ),
    ).toMatchObject({ allowed: false, reason: "NOT_PROBED" });
  });

  it("refuses at the concurrency limit but allows below it", () => {
    expect(
      evaluateProfileAvailability(obs({ activeWorkers: 1, maxConcurrency: 1 }), NOW, TTL),
    ).toMatchObject({ reason: "AT_CONCURRENCY_LIMIT" });
    expect(
      evaluateProfileAvailability(obs({ activeWorkers: 1, maxConcurrency: 2 }), NOW, TTL),
    ).toEqual({ allowed: true });
  });
});

describe("profile state machine", () => {
  it("has one rule per (state, event) pair and refuses undeclared pairs", () => {
    const keys = PROFILE_RULES.map((r) => `${r.from}|${r.event}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(transitionProfile("disabled", { type: "probe_succeeded" })).toMatchObject({
      ok: false,
      reason: "TRANSITION_NOT_ALLOWED",
    });
    expect(transitionProfile("cooldown", { type: "probe_succeeded" }).ok).toBe(false);
    expect(transitionProfile("login-required", { type: "probe_succeeded" }).ok).toBe(false);
  });

  it("moves a profile to cooldown on a limit only for a cooldown in the future", () => {
    const hit = (cooldownUntil: number): ProfileEvent => ({
      type: "limit_hit",
      now: NOW,
      cooldownUntil,
    });
    expect(transitionProfile("ready", hit(NOW))).toMatchObject({
      ok: false,
      reason: "COOLDOWN_NOT_IN_FUTURE",
    });
    expect(transitionProfile("ready", hit(NOW + 1))).toMatchObject({ ok: true, to: "cooldown" });
  });

  it("leaves cooldown only when it has elapsed, and lands on unknown, not ready", () => {
    const elapsed = (now: number): ProfileEvent => ({
      type: "cooldown_elapsed",
      now,
      cooldownUntil: NOW,
    });
    expect(transitionProfile("cooldown", elapsed(NOW - 1))).toMatchObject({
      reason: "COOLDOWN_NOT_ELAPSED",
    });
    expect(transitionProfile("cooldown", elapsed(NOW))).toMatchObject({ ok: true, to: "unknown" });
  });

  it("handles login failure as login-required, not as a limit, and recovers through unknown", () => {
    for (const from of ["unknown", "ready", "busy", "cooldown", "unavailable"] as const) {
      expect(transitionProfile(from, { type: "login_failed" })).toMatchObject({
        to: "login-required",
      });
    }
    expect(transitionProfile("login-required", { type: "login_completed" })).toMatchObject({
      to: "unknown",
    });
  });

  it("switches busy and ready on concurrency, refusing a wrong report", () => {
    expect(
      transitionProfile("ready", { type: "capacity_reached", activeWorkers: 0, maxConcurrency: 1 }),
    ).toMatchObject({ reason: "BELOW_CONCURRENCY_LIMIT" });
    expect(
      transitionProfile("ready", { type: "capacity_reached", activeWorkers: 1, maxConcurrency: 1 }),
    ).toMatchObject({ to: "busy" });
    expect(
      transitionProfile("busy", { type: "capacity_freed", activeWorkers: 1, maxConcurrency: 1 }),
    ).toMatchObject({ reason: "AT_CONCURRENCY_LIMIT" });
    expect(
      transitionProfile("busy", { type: "capacity_freed", activeWorkers: 0, maxConcurrency: 1 }),
    ).toMatchObject({ to: "ready" });
  });

  it("disables from any enabled state and re-enables into unknown", () => {
    for (const from of PROFILE_STATES.filter((s) => s !== "disabled")) {
      expect(transitionProfile(from, { type: "disable" })).toMatchObject({ to: "disabled" });
    }
    expect(transitionProfile("disabled", { type: "enable" })).toMatchObject({ to: "unknown" });
  });
});
