import { describe, expect, it } from "vitest";
import { selectExecutor } from "../../../../src/domain/agents/selection-policy.ts";
import type {
  ExecutorCandidate,
  SelectionInput,
} from "../../../../src/domain/agents/selection-policy.ts";
import type { QuotaVerdict } from "../../../../src/domain/profiles/quota-policy.ts";

const NOW = 1_000_000;

const candidate = (id: string, overrides: Partial<ExecutorCandidate> = {}): ExecutorCandidate => ({
  candidateId: id,
  executor: "claude-code",
  modelAlias: "opus",
  model: "claude-opus",
  modelAllowlist: ["claude-opus", "claude-sonnet"],
  profileId: `profile-${id}`,
  accountGroupId: `group-${id}`,
  profile: { state: "ready", lastProbeAt: NOW - 1000, activeWorkers: 0, maxConcurrency: 3 },
  supportedEfforts: ["high"],
  verifiedForCapability: true,
  preference: 1,
  probeTtlMs: 60_000,
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
    probeTtlMs: 60_000,
    ...overrides,
  });
const verdict = (profileId: string, over: Partial<QuotaVerdict> = {}): QuotaVerdict => ({
  profileId,
  freshness: "fresh",
  fiveHourLeft: 80,
  sevenDayLeft: 80,
  score: 80,
  blocked: [],
  blockedUntil: null,
  resetCredits: null,
  modelWindows: [],
  ...over,
});
const quota = (...verdicts: QuotaVerdict[]) => new Map(verdicts.map((v) => [v.profileId, v]));

describe("selectExecutor with quota verdicts", () => {
  it("rejects a candidate whose profile is below the quota threshold", () => {
    const result = select([candidate("a")], {
      quota: quota(verdict("profile-a", { blocked: ["FIVE_HOUR_BELOW_THRESHOLD"] })),
    });
    expect(result).toEqual({
      outcome: "WAITING_RESOURCE",
      rejections: [{ candidateId: "a", reasons: ["QUOTA_BELOW_THRESHOLD"] }],
    });
  });

  it("rejects a profile that shares the Coordinator account when the config forbids it", () => {
    const result = select([candidate("a")], {
      quota: quota(verdict("profile-a", { blocked: ["SHARES_COORDINATOR_ACCOUNT"] })),
    });
    expect(result).toEqual({
      outcome: "WAITING_RESOURCE",
      rejections: [{ candidateId: "a", reasons: ["SHARES_COORDINATOR_ACCOUNT"] }],
    });
  });

  it("ranks equal-preference candidates by quota score before load", () => {
    const roomy = candidate("roomy", {
      profile: { state: "ready", lastProbeAt: NOW, activeWorkers: 2, maxConcurrency: 3 },
    });
    const tight = candidate("tight");
    const result = select([tight, roomy], {
      quota: quota(
        verdict("profile-roomy", { score: 90 }),
        verdict("profile-tight", { score: 15 }),
      ),
    });
    expect(result).toMatchObject({ outcome: "selected", candidate: { candidateId: "roomy" } });
  });

  it("keeps configured preference ahead of quota score", () => {
    const preferred = candidate("preferred", { preference: 0 });
    const roomy = candidate("roomy", { preference: 5 });
    const result = select([roomy, preferred], {
      quota: quota(
        verdict("profile-preferred", { score: 12 }),
        verdict("profile-roomy", { score: 95 }),
      ),
    });
    expect(result).toMatchObject({ outcome: "selected", candidate: { candidateId: "preferred" } });
  });

  it("rejects only the model whose own weekly window is below the threshold", () => {
    const opus = candidate("opus");
    const sonnet = candidate("sonnet", {
      modelAlias: "sonnet",
      model: "claude-sonnet",
      profileId: "profile-opus",
    });
    const result = select([opus, sonnet], {
      quota: quota(
        verdict("profile-opus", {
          modelWindows: [{ model: "opus", left: 2, blocked: true, resetsAt: null }],
        }),
      ),
    });
    expect(result).toMatchObject({ outcome: "selected", candidate: { candidateId: "sonnet" } });
  });

  it("reports the weekly model window as its own rejection reason", () => {
    const result = select([candidate("opus")], {
      quota: quota(
        verdict("profile-opus", {
          modelWindows: [{ model: "Opus".toLowerCase(), left: 2, blocked: true, resetsAt: null }],
        }),
      ),
    });
    expect(result).toEqual({
      outcome: "WAITING_RESOURCE",
      rejections: [{ candidateId: "opus", reasons: ["MODEL_WEEKLY_QUOTA_BELOW_THRESHOLD"] }],
    });
  });

  it("does not block a candidate whose profile has no verdict", () => {
    expect(select([candidate("a")], { quota: quota() }).outcome).toBe("selected");
  });
});
