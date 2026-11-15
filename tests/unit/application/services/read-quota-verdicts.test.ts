import { describe, expect, it } from "vitest";
import type { QuotaReader } from "../../../../src/application/ports/quota-reader.ts";
import { createQuotaVerdictReader } from "../../../../src/application/services/read-quota-verdicts.ts";
import type { QuotaReading } from "../../../../src/domain/profiles/quota-policy.ts";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const POLICY = {
  min_five_hour_left_percent: 10,
  min_seven_day_left_percent: 10,
  coordinator_shared_penalty: 20,
  coordinator_shared_policy: "penalize" as const,
  coordinator_shared_profiles: [],
  stale_after_minutes: 60,
  probe_when_stale: true,
};
const PROFILES = {
  list: () =>
    [
      { metadata: { profileId: "claude-a", tool: "claude-code", credentialRef: "/p/a" } },
      { metadata: { profileId: "codex-b", tool: "codex", credentialRef: "/p/b" } },
    ] as never,
};
const reading = (observedAt: number, usedPercent: number): QuotaReading => ({
  source: "claude-usage-api",
  observedAt,
  fiveHour: { usedPercent, resetsAt: null },
  sevenDay: null,
  status: null,
  limited: false,
  resetCredits: null,
  modelWindows: [],
});

function recordingReader(stale: boolean) {
  const calls: { profileId: string; probe: boolean }[] = [];
  const reader: QuotaReader = {
    read: (profile, options) => {
      calls.push({ profileId: profile.profileId, probe: options.probe });
      const at = stale && !options.probe ? NOW - 3 * 3_600_000 : NOW;
      return Promise.resolve({ reading: reading(at, 40), note: null });
    },
  };
  return { reader, calls };
}

describe("createQuotaVerdictReader", () => {
  it("never probes when probing is off, even for a stale reading and a probing policy", async () => {
    const { reader, calls } = recordingReader(true);
    const verdicts = await createQuotaVerdictReader({
      policy: POLICY,
      reader,
      profiles: PROFILES,
      now: () => NOW,
      probe: false,
    })();
    expect(calls.every((call) => !call.probe)).toBe(true);
    expect(verdicts.get("claude-a")).toMatchObject({ freshness: "stale", fiveHourLeft: 60 });
  });

  it("probes a stale reading once when probing is on and the policy allows it", async () => {
    const { reader, calls } = recordingReader(true);
    const verdicts = await createQuotaVerdictReader({
      policy: POLICY,
      reader,
      profiles: PROFILES,
      now: () => NOW,
      probe: true,
    })();
    expect(calls.filter((call) => call.probe).map((call) => call.profileId)).toEqual([
      "claude-a",
      "codex-b",
    ]);
    expect(verdicts.get("claude-a")?.freshness).toBe("fresh");
  });

  it("counts a reader that throws as no reading", async () => {
    const verdicts = await createQuotaVerdictReader({
      policy: POLICY,
      reader: { read: () => Promise.reject(new Error("HTTP 401")) },
      profiles: PROFILES,
      now: () => NOW,
      probe: false,
    })();
    expect(verdicts.get("claude-a")).toMatchObject({ freshness: "unknown", blocked: [] });
  });

  it("reads only the profiles of the required executor", async () => {
    const { reader } = recordingReader(false);
    const verdicts = await createQuotaVerdictReader({
      policy: POLICY,
      reader,
      profiles: PROFILES,
      now: () => NOW,
      probe: false,
    })("codex");
    expect([...verdicts.keys()]).toEqual(["codex-b"]);
  });
});
