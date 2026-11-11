import { describe, expect, it } from "vitest";
import { observedProfile } from "../../../../src/domain/profiles/profile-metadata.ts";
import type { ProfileMetadata } from "../../../../src/domain/profiles/profile-metadata.ts";

const metadata: ProfileMetadata = {
  profileId: "p",
  tool: "claude-code",
  authMode: "subscription",
  credentialRef: "/profiles/p",
  accountGroupId: "g",
  modelAllowlist: [],
  state: "ready",
  lastProbeAt: 10,
  probeTtlMs: 10,
  maxConcurrency: 1,
  accountGroupMaxConcurrency: 1,
  preference: 0,
};
const view = (overrides: Partial<ProfileMetadata>, now = 20) =>
  observedProfile({ metadata: { ...metadata, ...overrides }, revision: 1, activeWorkers: 0 }, now);

describe("profile observation projection", () => {
  it("shows stale, never-probed and elapsed cooldown profiles as unknown", () => {
    expect(view({}).state).toBe("unknown");
    expect(view({}, 19).state).toBe("ready");
    const neverProbed = { ...metadata };
    delete neverProbed.lastProbeAt;
    expect(
      observedProfile({ metadata: neverProbed, revision: 1, activeWorkers: 0 }, 11).state,
    ).toBe("unknown");
    expect(view({ state: "cooldown", cooldownUntil: 20 }).state).toBe("unknown");
    expect(view({ state: "cooldown", cooldownUntil: 21 }).state).toBe("cooldown");
  });
  it.each(["unknown", "login-required", "unavailable", "disabled"] as const)(
    "preserves the actionable %s state when probe evidence is old",
    (state) => {
      expect(view({ state }).state).toBe(state);
    },
  );
});
