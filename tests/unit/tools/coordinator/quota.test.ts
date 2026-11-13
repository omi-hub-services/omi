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
  parseClaudeUsage,
  parseCodexRateLimits,
  parseQuotaOutput,
  pickProfile,
  quotaCommand,
  quotaRetryAt,
  quotaCacheDecision,
  parseCachedReading,
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
    modelWindows: [],
    ...over,
  };
}

const quota = (
  tool: "claude" | "codex",
  profile: string,
  r: QuotaReading | null,
  shared = false,
): ProfileQuota => ({
  tool,
  profile,
  sharesCoordinatorAccount: shared,
  reading: r,
  note: null,
  tokenExpiresAt: null,
});

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
      modelWindows: [],
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

  it("maps primary to the 5-hour and secondary to the weekly window, as codex-cli sends them", () => {
    const w = (usedPercent: number, windowDurationMins: number) => ({
      usedPercent,
      windowDurationMins,
      resetsAt: null,
    });
    // Durations are not used to reorder windows (never seen reversed; OMI-052).
    const r = parseCodexRateLimits(
      { rateLimits: { primary: w(1, 10080), secondary: w(2, 300) } },
      NOW,
    );
    expect(r).toMatchObject({ fiveHour: { usedPercent: 1 }, sevenDay: { usedPercent: 2 } });
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
    const r = pickProfile("claude", qs, settings, NOW, true);
    expect(r.ranked.map((c) => [c.profile, c.freshness])).toEqual([
      ["fresh", "fresh"],
      ["stale", "stale"],
      ["none", "unknown"],
    ]);
    expect(r.ok && r.chosen[0]?.profile).toBe("fresh");
    // After a probe that still found nothing, an unknown profile is the last resort.
    const unknown = [quota("claude", "none", null)];
    const probed = pickProfile("claude", unknown, settings, NOW, true);
    expect(probed.ok && probed.chosen[0]?.freshness).toBe("unknown");
  });

  it("never chooses a profile without quota data unless the run probed", () => {
    // e.g. minibox shares the Coordinator account and has no worker log yet.
    const qs = [quota("claude", "minibox", null, true)];
    const r = pickProfile("claude", qs, settings, NOW);
    expect(r).toMatchObject({ ok: false, earliestReset: null });
    expect(formatPick("pick-profile 65", r)[0]).toBe(
      "pick-profile 65: refused: claude: minibox no quota data; rerun pick-profile with --probe; earliest reset unknown",
    );
    const withData = [...qs, quota("claude", "own", reading(50, 50))];
    expect(pickProfile("claude", withData, settings, NOW)).toMatchObject({
      ok: true,
      chosen: [{ profile: "own" }],
    });
  });

  it("allows a profile with exactly 10% of the 5h window left", () => {
    const r = pickProfile("claude", [quota("claude", "a", reading(90, 0))], settings, NOW);
    expect(r).toMatchObject({
      ok: true,
      chosen: [{ profile: "a", fiveHourLeft: 10, blocked: null }],
    });
  });

  it("blocks a profile with 9% of the 5h window left and names the 10% threshold", () => {
    const r = pickProfile("claude", [quota("claude", "a", reading(91, 0))], settings, NOW);
    expect(r).toMatchObject({ ok: false, reason: "claude: a 5h 9% left < 10%" });
  });

  it("refuses below threshold with the earliest reset across profiles", () => {
    const a = reading(95, 0); // 5% of 5h left, resets in 2h
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
    expect(r.reason).toContain("a 5h 5% left < 10%");
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

  it("stops honouring a reported limit once every window has reset", () => {
    const old = reading(50, 50, {
      limited: true,
      status: "rejected",
      fiveHour: { usedPercent: 100, resetsAt: NOW - 2 * H },
      sevenDay: { usedPercent: 50, resetsAt: NOW - 1 },
    });
    expect(pickProfile("claude", [quota("claude", "a", old)], settings, NOW).ok).toBe(true);
    // One window still to reset keeps it blocked until then.
    const partly = { ...old, sevenDay: { usedPercent: 50, resetsAt: NOW + H } };
    const r = pickProfile("claude", [quota("claude", "a", partly)], settings, NOW);
    expect(r).toMatchObject({ ok: false, earliestReset: NOW + H });
  });

  it("blocks a limited reading with no window reset time", () => {
    const noWindows = reading(0, 0, {
      limited: true,
      status: "rejected",
      fiveHour: null,
      sevenDay: null,
    });
    const r = pickProfile("claude", [quota("claude", "a", noWindows)], settings, NOW);
    expect(r).toMatchObject({ ok: false, earliestReset: null });
    expect(!r.ok && r.reason).toContain("limit reached (rejected), no reset time");
    const nullResets = reading(10, 10, {
      limited: true,
      status: "rejected",
      fiveHour: { usedPercent: 10, resetsAt: null },
      sevenDay: { usedPercent: 10, resetsAt: null },
    });
    expect(pickProfile("claude", [quota("claude", "a", nullResets)], settings, NOW).ok).toBe(false);
    // A usable second profile is still chosen.
    const both = [quota("claude", "a", noWindows), quota("claude", "b", reading(10, 10))];
    expect(pickProfile("claude", both, settings, NOW).ok).toBe(true);
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

describe("parseClaudeUsage", () => {
  const T0 = Date.UTC(2026, 10, 11, 11, 10) / 1000;
  it("reads 0-100 utilization, ISO resets and the weekly_scoped model windows", () => {
    const r = parseClaudeUsage(fixture("claude-usage.json"), NOW);
    expect(r).toEqual({
      source: "claude-usage-api",
      observedAt: NOW,
      fiveHour: { usedPercent: 33, resetsAt: T0 },
      sevenDay: { usedPercent: 41.5, resetsAt: Date.UTC(2026, 10, 16, 7) / 1000 },
      status: "allowed",
      limited: false,
      planType: null,
      resetCredits: null,
      modelWindows: [
        { model: "Fable", usedPercent: 1, resetsAt: Date.UTC(2026, 10, 16, 7) / 1000 },
      ],
    });
  });

  it("marks a full window as limited and tolerates a null window and missing limits", () => {
    const r = parseClaudeUsage(
      { five_hour: { utilization: 100, resets_at: "2026-11-11T11:10:00Z" }, seven_day: null },
      NOW,
    );
    expect(r).toMatchObject({
      limited: true,
      status: "rejected",
      sevenDay: null,
      modelWindows: [],
    });
  });

  it("throws on a shape it does not know so the caller falls back to the log", () => {
    expect(() => parseClaudeUsage({}, NOW)).toThrow(/no five_hour or seven_day/);
    expect(() => parseClaudeUsage({ five_hour: { utilization: "x" } }, NOW)).toThrow(/utilization/);
    expect(() => parseClaudeUsage("nope", NOW)).toThrow();
  });
});

describe("usage endpoint source in parseQuotaOutput", () => {
  const usage = fixture("claude-usage.json");
  const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");
  const log = {
    kind: "log",
    file: "omi-060-ggtintran-20261110-160000.jsonl",
    mtime: NOW - 600,
    event: rawClaude,
  };

  it("prefers the usage endpoint over a log, with a fresh observedAt", () => {
    const { profiles } = parseQuotaOutput(
      lines({ kind: "now", now: NOW }, log, { kind: "usage", profile: "ggtintran", usage }),
      PROFILES,
      null,
    );
    expect(profiles[0]?.reading).toMatchObject({ source: "claude-usage-api", observedAt: NOW });
    expect(profiles[0]?.note).toBeNull();
  });

  it("prefers a probe over the usage endpoint", () => {
    const { profiles } = parseQuotaOutput(
      lines(
        { kind: "now", now: NOW },
        { kind: "usage", profile: "minibox", usage },
        { kind: "probe", profile: "minibox", event: rawClaude },
      ),
      PROFILES,
      null,
    );
    expect(profiles[1]?.reading?.source).toBe("claude-probe");
  });

  it.each([
    [
      "token expired",
      { kind: "error", tool: "claude-usage", profile: "ggtintran", message: "token expired" },
      "token expired",
    ],
    [
      "HTTP error",
      { kind: "error", tool: "claude-usage", profile: "ggtintran", message: "HTTP 429" },
      "HTTP 429",
    ],
    [
      "unknown schema",
      { kind: "usage", profile: "ggtintran", usage: { five_hour: 5 } },
      "unreadable data",
    ],
  ])("falls back to the log on %s and says why", (_name, event, why) => {
    const { profiles } = parseQuotaOutput(
      lines({ kind: "now", now: NOW }, log, event),
      PROFILES,
      null,
    );
    expect(profiles[0]?.reading).toMatchObject({ source: "claude-log", observedAt: NOW - 600 });
    expect(profiles[0]?.note).toContain(`usage api: ${why}`);
    const q = profiles[0];
    expect(
      q && formatQuotaSection({ available: true, now: NOW, profiles: [q] }).join("\n"),
    ).toContain(`[usage api: ${why}`);
  });

  it("explains a missing reading with the usage failure and the missing log", () => {
    const err = { kind: "error", tool: "claude-usage", profile: "minibox", message: "HTTP 401" };
    const { profiles } = parseQuotaOutput(lines({ kind: "now", now: NOW }, err), PROFILES, null);
    expect(profiles[1]).toMatchObject({ reading: null });
    expect(profiles[1]?.note).toMatch(/^usage api: HTTP 401; no worker log/);
  });

  it("shows model windows in the quota section", () => {
    const { profiles } = parseQuotaOutput(
      lines({ kind: "now", now: NOW }, { kind: "usage", profile: "minibox", usage }),
      PROFILES,
      null,
    );
    const text = formatQuotaSection({ available: true, now: NOW, profiles }).join("\n");
    expect(text).toContain("weekly Fable 99%");
    expect(text).toContain("(claude-usage-api)");
  });
});

describe("pickProfile with a per-model weekly window", () => {
  const fable = (used: number, resetsAt: number | null = NOW + 40 * H) => ({
    modelWindows: [{ model: "Fable", usedPercent: used, resetsAt }],
  });
  const qs = [
    quota("claude", "a", reading(10, 10, fable(95))),
    quota("claude", "b", reading(40, 40, fable(5))),
  ];

  it("ignores model windows when the worker has no model or another one", () => {
    for (const model of [null, "opus"]) {
      const r = pickProfile("claude", qs, settings, NOW, true, model);
      expect(r.ok && r.chosen[0]?.profile).toBe("a");
    }
  });

  it("refuses a profile whose window for the worker's exact model is under the 7d threshold", () => {
    const r = pickProfile("claude", qs, settings, NOW, true, "fable");
    expect(r.ok && r.chosen[0]?.profile).toBe("b");
    const a = r.ranked.find((c) => c.profile === "a");
    expect(a?.blocked).toBe("Fable weekly 5% left < 10%");
    expect(a?.blockedUntil).toBe(NOW + 40 * H);
    expect(formatPick("p", r).join("\n")).toContain("blocked: Fable weekly 5% left < 10%");
  });

  it("refuses with the earliest reset when every profile is out of that model", () => {
    const only = [quota("claude", "a", reading(10, 10, fable(95)))];
    const r = pickProfile("claude", only, settings, NOW, true, "Fable");
    expect(r).toMatchObject({ ok: false, earliestReset: NOW + 40 * H });
    expect(!r.ok && r.reason).toContain("Fable weekly 5% left");
  });

  it("treats a model window past its reset as full again", () => {
    const stale = [quota("claude", "a", reading(10, 10, fable(99, NOW - 1)))];
    expect(pickProfile("claude", stale, settings, NOW, true, "Fable").ok).toBe(true);
  });
});

describe("shared Claude cache decisions", () => {
  it("keeps the original age and source while a call is deferred, including an empty cache", () => {
    const good = reading(29, 49);
    expect(quotaCacheDecision({ reading: good, nextAllowedAt: NOW + 300 }, NOW + 299)).toEqual({
      call: false,
      reading: good,
    });
    expect(quotaCacheDecision({ reading: good, nextAllowedAt: NOW + 300 }, NOW + 300).call).toBe(
      true,
    );
    expect(quotaCacheDecision({ nextAllowedAt: NOW + 300 }, NOW)).toEqual({
      call: false,
      reading: null,
    });
    expect(quotaCacheDecision(null, NOW)).toEqual({ call: true, reading: null });
    expect(quotaCacheDecision({ nextAllowedAt: "tomorrow", reading: {} }, NOW)).toEqual({
      call: true,
      reading: null,
    });
  });

  it("honours delta seconds and HTTP dates, with a five-minute minimum/default", () => {
    expect(quotaRetryAt("600", NOW, 300)).toBe(NOW + 600);
    expect(quotaRetryAt(new Date((NOW + 900) * 1000).toUTCString(), NOW, 300)).toBe(NOW + 900);
    for (const value of [null, "garbage", "0", "-1", new Date((NOW - 100) * 1000).toUTCString()])
      expect(quotaRetryAt(value, NOW, 300)).toBe(NOW + 300);
  });

  it("prefers validated cache to old logs on 429 and retains source and true age", () => {
    const good = reading(29, 49, { observedAt: NOW - 300 });
    const output = [
      { kind: "now", now: NOW },
      {
        kind: "log",
        file: "omi-068-ggtintran-20261111-120000.jsonl",
        mtime: NOW - 61200,
        event: { rate_limit_info: { status: "allowed" } },
      },
      { kind: "cache", profile: "ggtintran", reading: good },
      { kind: "error", tool: "claude-usage", profile: "ggtintran", message: "HTTP 429" },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    const result = parseQuotaOutput(output, PROFILES, null);
    expect(result.profiles[0]).toMatchObject({ reading: good, note: "usage api: HTTP 429" });
    expect(formatQuotaSection({ available: true, ...result }).join("\n")).toContain(
      "data 5m old (claude-probe)",
    );
    expect(parseCachedReading({ ...good, accessToken: "never-kept" })).toEqual(good);
    expect(
      parseCachedReading({ ...good, fiveHour: { usedPercent: "bad", resetsAt: null } }),
    ).toBeNull();
  });
});

it("chooses one QA/review profile across tools by remaining quota", () => {
  const quotas = [quota("claude", "a", reading(70, 70)), quota("codex", "b", reading(10, 10))];
  const result = pickProfile("quality", quotas, settings, NOW, true, "sonnet");
  expect(result).toMatchObject({ ok: true, chosen: [{ tool: "codex", profile: "b" }] });
});
