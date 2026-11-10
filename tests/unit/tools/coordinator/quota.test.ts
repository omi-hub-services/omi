import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  QUOTA_SETTINGS,
  type QuotaSettings,
  type WorkerProfile,
  type WslTarget,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import {
  WSL_NODE_ENV,
  type Command,
  type Runner,
} from "../../../../tools/coordinator/process-runner.ts";
import {
  formatPick,
  formatQuotaSection,
  logProfile,
  parseClaudeRateLimitEvent,
  parseCodexRateLimits,
  parseQuotaOutput,
  pickProfile,
  quotaCommand,
  readQuota,
  type ProfileQuota,
  type QuotaReading,
} from "../../../../tools/coordinator/quota.ts";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../fixtures/coordinator/${name}`, import.meta.url), "utf8"),
  );

const NOW = 1794290000;
const H = 3600;
const settings: QuotaSettings = { ...QUOTA_SETTINGS, legacyLogProfile: null };
const PROFILES: readonly WorkerProfile[] = [
  { tool: "claude", profile: "ggtintran", sharesCoordinatorAccount: false },
  { tool: "claude", profile: "minibox", sharesCoordinatorAccount: true },
  { tool: "codex", profile: "ggtintran", sharesCoordinatorAccount: false },
];
const linux: WslTarget = { viaWslExe: false, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };

function reading(used5: number, used7: number, over: Partial<QuotaReading> = {}): QuotaReading {
  return {
    source: "claude-probe",
    observedAt: NOW,
    fiveHour: { usedPercent: used5, resetsAt: NOW + 2 * H },
    sevenDay: { usedPercent: used7, resetsAt: NOW + 50 * H },
    status: "allowed",
    limited: false,
    planType: null,
    resetCredits: null,
    ...over,
  };
}

const quota = (
  tool: "claude" | "codex",
  profile: string,
  r: QuotaReading | null,
  shared = false,
): ProfileQuota => ({ tool, profile, sharesCoordinatorAccount: shared, reading: r, note: null });

// Raw provider output as it really arrives: account fields included.
const SECRET = {
  accountId: "acct-9f1c2d3e-secret",
  email: "someone@example.com",
  creditId: "credit-7a7a7a7a",
};
const rawCodex = {
  ...(fixture("codex-rate-limits.json") as Record<string, unknown>),
  accountId: SECRET.accountId,
  email: SECRET.email,
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [{ id: SECRET.creditId, grantedAt: 1 }],
  },
};
const rawClaude = {
  ...(fixture("claude-rate-limit-event.json") as Record<string, unknown>),
  session_id: "s-1",
  account: { email: SECRET.email, accountId: SECRET.accountId },
};

describe("parseCodexRateLimits", () => {
  it("reads the 5-hour and weekly windows, plan and the reset-credit count only", () => {
    const r = parseCodexRateLimits(fixture("codex-rate-limits.json"), NOW);
    expect(r).toEqual({
      source: "codex-app-server",
      observedAt: NOW,
      fiveHour: { usedPercent: 12, resetsAt: 1794310800 },
      sevenDay: { usedPercent: 99, resetsAt: 1794657600 },
      status: "allowed",
      limited: false,
      planType: "plus",
      resetCredits: 2,
    });
  });

  it("marks a reached limit and fails loudly on an unknown shape", () => {
    const limited = parseCodexRateLimits(
      { rateLimits: { primary: null, secondary: null, rateLimitReachedType: "secondary" } },
      NOW,
    );
    expect(limited).toMatchObject({ limited: true, status: "secondary", fiveHour: null });
    expect(() => parseCodexRateLimits({ nope: 1 }, NOW)).toThrow(/codex rateLimits/);
  });
});

describe("parseClaudeRateLimitEvent", () => {
  it("converts unified window utilization to percent used", () => {
    const r = parseClaudeRateLimitEvent(fixture("claude-rate-limit-event.json"), 5, "claude-log");
    expect(r).toMatchObject({
      source: "claude-log",
      observedAt: 5,
      fiveHour: { usedPercent: 68, resetsAt: 1794310800 },
      sevenDay: { usedPercent: 26, resetsAt: 1794657600 },
      status: "allowed",
      limited: false,
    });
  });
});

describe("logProfile", () => {
  it("takes the profile from omi-NNN-<profile>-<ts>.jsonl and ignores unknown names", () => {
    const names = ["ggtintran", "minibox"];
    expect(logProfile("omi-053-ggtintran-20261110-155824.jsonl", names, null)).toBe("ggtintran");
    expect(logProfile("omi-002-resume-20261110-143110.jsonl", names, null)).toBeNull();
    expect(logProfile("omi-002-20261110-142459.jsonl", names, null)).toBeNull();
    expect(logProfile("omi-002-20261110-142459.jsonl", names, "ggtintran")).toBe("ggtintran");
    expect(logProfile("smoke-20261110-142325.jsonl", names, "ggtintran")).toBeNull();
  });
});

describe("parseQuotaOutput", () => {
  const out = [
    { kind: "now", now: NOW },
    {
      kind: "log",
      file: "omi-060-ggtintran-20261110-160000.jsonl",
      mtime: NOW - 600,
      event: rawClaude,
    },
    { kind: "log", file: "omi-053-ggtintran-20261110-155824.jsonl", mtime: NOW - 9000, event: {} },
    { kind: "log", file: "omi-051-20261110-152010.jsonl", mtime: NOW - 99, event: rawClaude },
    { kind: "codex", profile: "ggtintran", result: rawCodex },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");

  it("keeps the newest log per profile, ignores unnamed logs and notes missing data", () => {
    const { now, profiles } = parseQuotaOutput(out, PROFILES, null);
    expect(now).toBe(NOW);
    expect(profiles[0]?.reading).toMatchObject({ source: "claude-log", observedAt: NOW - 600 });
    expect(profiles[1]).toMatchObject({ profile: "minibox", reading: null });
    expect(profiles[1]?.note).toMatch(/no worker log/);
    expect(profiles[2]?.reading).toMatchObject({ source: "codex-app-server", resetCredits: 2 });
  });

  it("prefers a probe over a log and reports collector errors as notes", () => {
    const probe = JSON.stringify({ kind: "probe", profile: "minibox", event: rawClaude });
    const error = JSON.stringify({
      kind: "error",
      tool: "codex",
      profile: "ggtintran",
      message: "codex could not start",
    });
    const lines = [JSON.stringify({ kind: "now", now: NOW }), probe, error, "garbage {"].join("\n");
    const { profiles } = parseQuotaOutput(lines, PROFILES, null);
    expect(profiles[1]?.reading?.source).toBe("claude-probe");
    expect(profiles[2]).toMatchObject({ reading: null, note: "codex could not start" });
  });

  it("never lets accountId, an email or a credit id reach text or JSON output", () => {
    const report = { available: true as const, ...parseQuotaOutput(out, PROFILES, null) };
    const result = pickProfile("claude+codex-live", report.profiles, settings, NOW);
    const printed = [
      JSON.stringify(report),
      formatQuotaSection(report).join("\n"),
      formatPick("pick-profile 66", result).join("\n"),
      JSON.stringify(result),
    ].join("\n");
    for (const secret of Object.values(SECRET)) expect(printed).not.toContain(secret);
    expect(printed).not.toMatch(/accountId|@example\.com|session_id/);
  });
});

describe("quotaCommand / readQuota", () => {
  it("sends the collector on stdin with a payload that survives Windows quoting", () => {
    const cmd = quotaCommand({ ...linux, viaWslExe: true }, PROFILES, true);
    expect(cmd.file).toBe("wsl.exe");
    // bash -lc does not load nvm on its own; without it wsl.exe reports "node: command not found".
    expect(cmd.args.at(-1)).toBe(
      `${WSL_NODE_ENV} node --input-type=module - omi-runs 1 claude:ggtintran claude:minibox codex:ggtintran`,
    );
    expect(cmd.input).toContain("account/rateLimits/read");
    expect(() =>
      quotaCommand(
        linux,
        [{ tool: "claude", profile: "a b", sharesCoordinatorAccount: false }],
        false,
      ),
    ).toThrow(/invalid profile/);
  });

  it("degrades to unavailable instead of throwing", async () => {
    const calls: Command[] = [];
    const run: Runner = (c) => {
      calls.push(c);
      return Promise.resolve({ code: 127, stdout: "", stderr: "node: not found" });
    };
    const r = await readQuota(run, linux, PROFILES, settings, false);
    expect(r).toEqual({ available: false, reason: "bash exited 127: node: not found" });
    expect(calls[0]?.file).toBe("bash");
  });
});

describe("pickProfile", () => {
  it("picks the profile with the most left in its tighter window", () => {
    const r = pickProfile(
      "claude",
      [quota("claude", "a", reading(20, 70)), quota("claude", "b", reading(10, 40))],
      settings,
      NOW,
    );
    expect(r.ok && r.chosen.map((c) => [c.profile, c.score])).toEqual([["b", 60]]);
  });

  it("penalises the profile that shares the Coordinator's account", () => {
    const qs = [
      quota("claude", "own", reading(50, 50)),
      quota("claude", "shared", reading(35, 35), true),
    ];
    const r = pickProfile("claude", qs, settings, NOW);
    expect(r.ok && r.chosen[0]?.profile).toBe("own");
    expect(r.ranked.find((c) => c.profile === "shared")?.score).toBe(45);
  });

  it("ranks fresh readings above stale ones and unknown last", () => {
    const stale = reading(0, 0, { observedAt: NOW - (settings.staleAfterMinutes + 1) * 60 });
    const qs = [
      quota("claude", "none", null),
      quota("claude", "stale", stale),
      quota("claude", "fresh", reading(60, 60)),
    ];
    const r = pickProfile("claude", qs, settings, NOW);
    expect(r.ranked.map((c) => [c.profile, c.freshness])).toEqual([
      ["fresh", "fresh"],
      ["stale", "stale"],
      ["none", "unknown"],
    ]);
    expect(r.ok && r.chosen[0]?.profile).toBe("fresh");
    const onlyUnknown = pickProfile("claude", [quota("claude", "none", null)], settings, NOW);
    expect(onlyUnknown.ok && onlyUnknown.chosen[0]?.freshness).toBe("unknown");
  });

  it("refuses below threshold with the earliest reset across profiles", () => {
    const a = reading(75, 0); // 25% of 5h left, resets in 2h
    const b = reading(0, 95, { sevenDay: { usedPercent: 95, resetsAt: NOW + 30 * H } });
    const r = pickProfile(
      "claude",
      [quota("claude", "a", a), quota("claude", "b", b)],
      settings,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.earliestReset).toBe(NOW + 2 * H);
    expect(r.reason).toContain("a 5h 25% left < 30%");
    expect(r.reason).toContain("b 7d 5% left < 10%");
    expect(formatPick("pick-profile 66", r)[0]).toMatch(/^pick-profile 66: refused: claude: /);
  });

  it("treats a window whose reset time has passed as full", () => {
    const r = reading(100, 0, { fiveHour: { usedPercent: 100, resetsAt: NOW - 1 } });
    expect(pickProfile("claude", [quota("claude", "a", r)], settings, NOW).ok).toBe(true);
  });

  it("refuses a provider-reported limit even above the thresholds", () => {
    const r = reading(50, 50, { limited: true, status: "rejected" });
    const result = pickProfile("claude", [quota("claude", "a", r)], settings, NOW);
    // Which window hit the limit is unknown, so wait for the later reset (conservative).
    expect(!result.ok && result.earliestReset).toBe(NOW + 50 * H);
  });

  it("claude+codex-live needs both tools; codex alone ignores Claude profiles", () => {
    const codexLow = reading(0, 99, { source: "codex-app-server", resetCredits: 2 });
    const qs = [quota("claude", "c", reading(10, 10)), quota("codex", "x", codexLow)];
    const live = pickProfile("claude+codex-live", qs, settings, NOW);
    expect(live.ok).toBe(false);
    if (!live.ok) {
      expect(live.reason).toMatch(/^codex: x 7d 1% left/);
      expect(live.earliestReset).toBe(NOW + 50 * H);
    }
    // Reset credits are reported for the PO, never used.
    expect(formatPick("p", live).join("\n")).toContain("codex x has 2 reset credits (PO decision)");
    const ok = [quota("claude", "c", reading(10, 10)), quota("codex", "x", reading(10, 10))];
    const both = pickProfile("claude+codex-live", ok, settings, NOW);
    expect(both.ok && both.chosen.map((c) => `${c.tool}:${c.profile}`)).toEqual([
      "claude:c",
      "codex:x",
    ]);
    expect(pickProfile("codex", ok, settings, NOW).ranked.map((c) => c.tool)).toEqual(["codex"]);
    expect(pickProfile("codex", qs.slice(0, 1), settings, NOW)).toMatchObject({
      ok: false,
      reason: "codex: no profile configured",
      earliestReset: null,
    });
  });
});
