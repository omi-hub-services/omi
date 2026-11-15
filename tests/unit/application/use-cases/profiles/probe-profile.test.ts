import { describe, expect, it } from "vitest";
import { probeProfile } from "../../../../../src/application/use-cases/profiles/probe-profile.ts";
import type { AgentExecutor } from "../../../../../src/application/ports/agent-executor.ts";
import type { ProfileRegistry } from "../../../../../src/application/ports/profile-registry.ts";
import type { ProfileMetadata } from "../../../../../src/domain/profiles/profile-metadata.ts";
import type { ProbeResult } from "../../../../../src/application/contracts/agent-execution.ts";

const metadata: ProfileMetadata = {
  profileId: "p",
  tool: "claude-code",
  credentialRef: "/profiles/p",
  authMode: "subscription",
  accountGroupId: "g",
  state: "unknown",
  modelAllowlist: [],
  probeTtlMs: 100,
  maxConcurrency: 1,
  accountGroupMaxConcurrency: 1,
  preference: 0,
};
function setup(overrides: Partial<ProfileMetadata> = {}, activeWorkers = 0) {
  let saved = { ...metadata, ...overrides };
  let time = 100;
  let probes = 0;
  const registry: ProfileRegistry = {
    list: () => [{ metadata: saved, activeWorkers, revision: 5 }],
    save(input, at, revision) {
      expect(revision).toBe(5);
      expect(at).toBe(101);
      saved = input;
      return true;
    },
  };
  const executor = (status: ProbeResult["status"]): Pick<AgentExecutor, "executor" | "probe"> => ({
    executor: "claude-code",
    probe(input) {
      expect(input).toEqual({ profileHome: "/profiles/p" });
      probes++;
      time = 101;
      return Promise.resolve({
        executor: "claude-code",
        status,
        compatibility: "supported",
        supportedRange: "test",
      });
    },
  });
  return { registry, executor, clock: () => time, saved: () => saved, probes: () => probes };
}
describe("probeProfile", () => {
  it("returns the adapter diagnostic so an unavailable profile has an actionable reason", async () => {
    const test = setup();
    const base = test.executor("unavailable");
    const diagnostic =
      "claude executable not found or not runnable; reinstall/update omi-squad after installing the CLI";
    const executor = {
      ...base,
      probe: async (input: Parameters<typeof base.probe>[0]) => ({
        ...(await base.probe(input)),
        diagnostic,
      }),
    };
    expect(await probeProfile(test.registry, executor, "p", test.clock)).toMatchObject({
      diagnostic,
    });
  });
  it.each([
    ["ready", "ready"],
    ["login-required", "login-required"],
    ["unsupported-auth-mode", "unavailable"],
    ["unsupported-version", "unavailable"],
    ["unavailable", "unavailable"],
  ] as const)("maps %s to %s without adding models from a login probe", async (status, state) => {
    const test = setup();
    expect(await probeProfile(test.registry, test.executor(status), "p", test.clock)).toEqual({
      outcome: "probed",
      status,
    });
    expect(test.saved()).toMatchObject({ state, lastProbeAt: 101, modelAllowlist: [] });
  });
  it("samples completion time and preserves busy workers on a successful probe", async () => {
    const test = setup({}, 1);
    await probeProfile(test.registry, test.executor("ready"), "p", test.clock);
    expect(test.saved()).toMatchObject({ state: "busy", lastProbeAt: 101 });
  });
  it.each([{ state: "disabled" as const }, { state: "cooldown" as const, cooldownUntil: 200 }])(
    "does not probe or erase a protected $state",
    async (overrides) => {
      const test = setup(overrides);
      expect(await probeProfile(test.registry, test.executor("ready"), "p", test.clock)).toEqual({
        outcome: overrides.state,
      });
      expect(test.probes()).toBe(0);
    },
  );
  it("recovers login-required and elapsed cooldown only with a fresh probe", async () => {
    for (const overrides of [
      { state: "login-required" as const },
      { state: "cooldown" as const, cooldownUntil: 100 },
    ]) {
      const test = setup(overrides);
      await probeProfile(test.registry, test.executor("ready"), "p", test.clock);
      expect(test.saved()).toMatchObject({ state: "ready", lastProbeAt: 101 });
      expect(test.saved().cooldownUntil).toBeUndefined();
    }
  });
  it("rejects unknown profiles, mismatched tools and malformed probe results before saving", async () => {
    const test = setup();
    await expect(
      probeProfile(test.registry, test.executor("ready"), "missing", test.clock),
    ).rejects.toThrow(/Unknown/);
    await expect(
      probeProfile(
        test.registry,
        { ...test.executor("ready"), executor: "codex" },
        "p",
        test.clock,
      ),
    ).rejects.toThrow(/mismatch/);
    const mismatched = {
      ...test.executor("ready"),
      probe: () =>
        Promise.resolve({
          executor: "codex" as const,
          status: "ready" as const,
          compatibility: "supported" as const,
          supportedRange: "test",
        }),
    };
    await expect(probeProfile(test.registry, mismatched, "p", test.clock)).rejects.toThrow(
      /mismatch/,
    );
    expect(test.saved().state).toBe("unknown");
  });
});
