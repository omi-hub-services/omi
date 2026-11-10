import { describe, expect, it } from "vitest";
import { selectExecutor } from "../../../../src/domain/agents/selection-policy.ts";
import type {
  ExecutorCandidate,
  SelectionInput,
} from "../../../../src/domain/agents/selection-policy.ts";

const NOW = 1_000_000;
const TTL = 60_000;

const candidate = (id: string, overrides: Partial<ExecutorCandidate> = {}): ExecutorCandidate => ({
  candidateId: id,
  executor: "claude-code",
  modelAlias: "opus",
  profileId: `profile-${id}`,
  accountGroupId: `group-${id}`,
  profile: {
    state: "ready",
    lastProbeAt: NOW - 1000,
    activeWorkers: 0,
    maxConcurrency: 1,
  },
  supportedEfforts: ["medium", "high", "xhigh"],
  verifiedForCapability: true,
  preference: 1,
  ...overrides,
});

const select = (candidates: ExecutorCandidate[], overrides: Partial<SelectionInput> = {}) =>
  selectExecutor({
    requirement: { minEffort: "high" },
    candidates,
    cooldownAccountGroups: new Set(),
    now: NOW,
    probeTtlMs: TTL,
    ...overrides,
  });

describe("selectExecutor", () => {
  it("selects a qualifying candidate with the lowest effort that meets the minimum", () => {
    const result = select([candidate("a")]);
    expect(result).toMatchObject({ outcome: "selected", effort: "high" });
  });

  it("applies the capability floor before preference: a preferred weak model loses", () => {
    const weak = candidate("weak", { preference: 0, supportedEfforts: ["low", "medium"] });
    const strong = candidate("strong", { preference: 9 });
    const result = select([weak, strong]);
    expect(result).toMatchObject({ outcome: "selected", candidate: { candidateId: "strong" } });
  });

  it("does not pick a candidate only because it has quota when the model is not verified", () => {
    const result = select([candidate("a", { verifiedForCapability: false })]);
    expect(result).toEqual({
      outcome: "WAITING_RESOURCE",
      rejections: [{ candidateId: "a", reasons: ["MODEL_NOT_VERIFIED"] }],
    });
  });

  it("ranks qualifying candidates by preference, then load, then id", () => {
    const busy = candidate("busy", {
      profile: { state: "ready", lastProbeAt: NOW, activeWorkers: 0, maxConcurrency: 3 },
    });
    const loaded = candidate("loaded", {
      profile: { state: "ready", lastProbeAt: NOW, activeWorkers: 2, maxConcurrency: 3 },
    });
    expect(select([loaded, busy])).toMatchObject({ candidate: { candidateId: "busy" } });
    expect(select([candidate("b"), candidate("a")])).toMatchObject({
      candidate: { candidateId: "a" },
    });
    expect(
      select([candidate("a", { preference: 5 }), candidate("b", { preference: 2 })]),
    ).toMatchObject({ candidate: { candidateId: "b" } });
  });

  it("waits for a resource and explains every missing condition per candidate", () => {
    const result = select(
      [
        candidate("a", {
          profile: { state: "login-required", activeWorkers: 0, maxConcurrency: 1 },
        }),
        candidate("b", { supportedEfforts: ["low"], verifiedForCapability: false }),
      ],
      { cooldownAccountGroups: new Set(["group-b"]) },
    );
    expect(result).toEqual({
      outcome: "WAITING_RESOURCE",
      rejections: [
        { candidateId: "a", reasons: ["LOGIN_REQUIRED"] },
        {
          candidateId: "b",
          reasons: ["ACCOUNT_GROUP_IN_COOLDOWN", "MODEL_NOT_VERIFIED", "EFFORT_BELOW_MINIMUM"],
        },
      ],
    });
  });

  it("does not move to a second profile of an account group that is in cooldown", () => {
    const sameGroup = { accountGroupId: "shared" };
    const result = select([candidate("a", sameGroup), candidate("b", sameGroup)], {
      cooldownAccountGroups: new Set(["shared"]),
    });
    expect(result.outcome).toBe("WAITING_RESOURCE");
  });

  it("rejects unknown, stale-probe and at-limit profiles", () => {
    const result = select([
      candidate("unknown", { profile: { state: "unknown", activeWorkers: 0, maxConcurrency: 1 } }),
      candidate("stale", {
        profile: { state: "ready", lastProbeAt: NOW - TTL, activeWorkers: 0, maxConcurrency: 1 },
      }),
      candidate("full", {
        profile: { state: "ready", lastProbeAt: NOW, activeWorkers: 1, maxConcurrency: 1 },
      }),
    ]);
    expect(result).toEqual({
      outcome: "WAITING_RESOURCE",
      rejections: [
        { candidateId: "unknown", reasons: ["NOT_PROBED"] },
        { candidateId: "stale", reasons: ["PROBE_STALE"] },
        { candidateId: "full", reasons: ["AT_CONCURRENCY_LIMIT"] },
      ],
    });
  });

  it("waits when there are no candidates at all", () => {
    expect(select([])).toEqual({ outcome: "WAITING_RESOURCE", rejections: [] });
  });
});
