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
  model: "verified-model",
  modelAllowlist: ["verified-model"],
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
  accountGroupActiveWorkers: 0,
  accountGroupMaxConcurrency: 3,
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

describe("verified profile models and tool requirements", () => {
  it("requires both capability verification and the profile's explicit CLI-model allowlist", () => {
    expect(select([candidate("a", { modelAllowlist: ["opus"] })])).toMatchObject({
      outcome: "WAITING_RESOURCE",
      rejections: [{ reasons: ["MODEL_NOT_ALLOWLISTED"] }],
    });
    expect(select([candidate("a", { modelAllowlist: [] })]).outcome).toBe("WAITING_RESOURCE");
  });

  it.each(["unknown", "cooldown", "login-required", "unavailable", "disabled"] as const)(
    "never selects an ineligible %s profile",
    (state) => {
      expect(
        select([
          candidate("a", {
            profile: {
              state,
              lastProbeAt: NOW,
              cooldownUntil: NOW + 1,
              activeWorkers: 0,
              maxConcurrency: 1,
            },
          }),
        ]).outcome,
      ).toBe("WAITING_RESOURCE");
    },
  );

  it("allows busy profiles below their verified concurrency ceiling", () => {
    expect(
      select([
        candidate("busy", {
          profile: {
            state: "busy",
            lastProbeAt: NOW,
            activeWorkers: 1,
            maxConcurrency: 2,
          },
        }),
      ]).outcome,
    ).toBe("selected");
  });

  it("enforces account concurrency independently of profile capacity", () => {
    expect(
      select([
        candidate("a", {
          accountGroupActiveWorkers: 2,
          accountGroupMaxConcurrency: 2,
        }),
      ]),
    ).toMatchObject({
      outcome: "WAITING_RESOURCE",
      rejections: [{ reasons: ["ACCOUNT_GROUP_AT_CONCURRENCY_LIMIT"] }],
    });
    expect(
      select([
        candidate("a", {
          accountGroupActiveWorkers: 1,
          accountGroupMaxConcurrency: 2,
        }),
      ]).outcome,
    ).toBe("selected");
  });

  it("keeps the capability floor on Codex-to-Claude failover, or waits if Codex is required", () => {
    const limited = candidate("codex", {
      executor: "codex",
      preference: 0,
      profile: { state: "cooldown", cooldownUntil: NOW + 1, activeWorkers: 0, maxConcurrency: 1 },
    });
    const claude = candidate("claude", { supportedEfforts: ["low", "high"] });
    expect(select([limited, claude])).toMatchObject({
      candidate: { executor: "claude-code" },
      effort: "high",
    });
    expect(select([limited, claude], { requiredExecutor: "codex" }).outcome).toBe(
      "WAITING_RESOURCE",
    );
    expect(select([limited, candidate("weak", { supportedEfforts: ["medium"] })]).outcome).toBe(
      "WAITING_RESOURCE",
    );
  });

  it("uses the profile TTL and rejects evidence from a future clock", () => {
    expect(select([candidate("a", { probeTtlMs: 1 })]).outcome).toBe("WAITING_RESOURCE");
    expect(
      select([
        candidate("a", {
          profile: {
            state: "ready",
            lastProbeAt: NOW + 1,
            activeWorkers: 0,
            maxConcurrency: 1,
          },
        }),
      ]).outcome,
    ).toBe("WAITING_RESOURCE");
  });
});
