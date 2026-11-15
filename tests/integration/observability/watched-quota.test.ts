import { describe, expect, it } from "vitest";
import { watchedQuota } from "../../../src/bootstrap/container.ts";
import type { QuotaVerdict } from "../../../src/domain/profiles/quota-policy.ts";
import type { RegisteredProfile } from "../../../src/domain/profiles/profile-metadata.ts";

const verdict = (profileId: string): QuotaVerdict => ({
  profileId,
  freshness: "fresh",
  fiveHourLeft: 50,
  sevenDayLeft: 50,
  fiveHourResetsAt: null,
  score: 50,
  blocked: [],
  blockedUntil: null,
  resetCredits: null,
  modelWindows: [],
});
const registered = (profileId: string, tool: "claude-code" | "codex"): RegisteredProfile =>
  ({
    metadata: { profileId, tool },
    revision: 1,
    activeWorkers: 0,
  }) as unknown as RegisteredProfile;
const policy = {
  min_five_hour_left_percent: 12,
  min_seven_day_left_percent: 8,
} as never;

function source(profiles: RegisteredProfile[], verdicts: string[]) {
  return watchedQuota(policy, {
    registry: { list: () => profiles },
    verdicts: () => Promise.resolve(new Map(verdicts.map((id) => [id, verdict(id)]))),
  });
}

describe("watchedQuota: the watch page's quota source", () => {
  it("maps a registered profile to the tool of its executor", async () => {
    const quota = source([registered("a", "claude-code"), registered("b", "codex")], ["a", "b"]);
    const rows = await quota.read();
    expect(rows.map((r) => [r.verdict.profileId, r.tool])).toEqual([
      ["a", "claude"],
      ["b", "codex"],
    ]);
  });

  it("shows a profile the registry does not know as an unknown tool, never drops it", async () => {
    const rows = await source([registered("a", "codex")], ["a", "ghost"]).read();
    expect(rows.map((r) => [r.verdict.profileId, r.tool])).toEqual([
      ["a", "codex"],
      ["ghost", "unknown"],
    ]);
  });

  it("hands the policy's own thresholds to the shared severity rule", () => {
    expect(source([], []).thresholds).toEqual({
      minFiveHourLeftPercent: 12,
      minSevenDayLeftPercent: 8,
    });
  });

  it("reads the registry at every read, so a profile added later is mapped", async () => {
    const profiles: RegisteredProfile[] = [];
    const quota = source(profiles, ["late"]);
    expect((await quota.read())[0]?.tool).toBe("unknown");
    profiles.push(registered("late", "claude-code"));
    expect((await quota.read())[0]?.tool).toBe("claude");
  });
});
