import { describe, expect, it } from "vitest";
import {
  QUOTA_SETTINGS,
  type WorkerProfile,
  type WslTarget,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import { WSL_NODE_ENV } from "../../../../tools/coordinator/process-runner.ts";
import {
  formatPick,
  formatQuotaLine,
  parseQuotaOutput,
  pickProfile,
  quotaCommand,
  REMOTE_COLLECTOR,
} from "../../../../tools/coordinator/quota.ts";

const NOW = 1794290000;
const H = 3600;
const settings = { ...QUOTA_SETTINGS, legacyLogProfile: null };
const linux: WslTarget = { viaWslExe: false, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };
const claude: readonly WorkerProfile[] = [
  { tool: "claude", profile: "ggtintran", sharesCoordinatorAccount: false },
];

const cached = {
  source: "claude-probe",
  observedAt: NOW - 9 * H,
  fiveHour: { usedPercent: 30, resetsAt: NOW + H },
  sevenDay: { usedPercent: 40, resetsAt: NOW + 50 * H },
  status: "allowed",
  limited: false,
  modelWindows: [],
};
const lines = (...rows: object[]) => rows.map((o) => JSON.stringify(o)).join("\n");
const expiredOut = lines(
  { kind: "now", now: NOW },
  { kind: "expired", profile: "ggtintran", expiresAt: (NOW - 8 * H) * 1000 },
  { kind: "error", tool: "claude-usage", profile: "ggtintran", message: "token expired" },
  { kind: "cache", profile: "ggtintran", reading: cached },
);

describe("expired OAuth token (OMI-094)", () => {
  it("marks the profile and keeps the old reading with its age", () => {
    const [entry] = parseQuotaOutput(expiredOut, claude, null).profiles;
    expect(entry?.tokenExpiresAt).toBe(NOW - 8 * H);
    expect(entry?.reading?.observedAt).toBe(NOW - 9 * H);
    expect(entry?.note).toBe("usage api: token expired");
  });

  it("leaves a valid token unmarked", () => {
    const out = lines(
      { kind: "now", now: NOW },
      { kind: "cache", profile: "ggtintran", reading: cached },
    );
    expect(parseQuotaOutput(out, claude, null).profiles[0]?.tokenExpiresAt).toBeNull();
  });

  it("status line and pick-profile both say token expired with the data age", () => {
    const parsed = parseQuotaOutput(expiredOut, claude, null);
    const [entry] = parsed.profiles;
    const line = entry ? formatQuotaLine(entry, NOW) : "";
    expect(line).toContain("data 9h old");
    expect(line).toContain("token expired");
    const pick = pickProfile("claude", parsed.profiles, settings, NOW);
    expect(formatPick("pick", pick).join("\n")).toContain("token expired, data 9h old");
  });

  it("names a collector error instead of swallowing it", () => {
    const out = lines(
      { kind: "now", now: NOW },
      { kind: "error", tool: "claude-usage", profile: "ggtintran", message: "HTTP 500" },
      { kind: "cache", profile: "ggtintran", reading: cached },
    );
    const parsed = parseQuotaOutput(out, claude, null);
    expect(parsed.profiles[0]?.note).toBe("usage api: HTTP 500");
    expect(
      formatPick("pick", pickProfile("claude", parsed.profiles, settings, NOW)).join("\n"),
    ).toContain("usage api: HTTP 500");
  });

  it("asks the collector for the expiry-probe mode only when told to", () => {
    expect(quotaCommand(linux, claude, "expired").args.at(-1)).toBe(
      `${WSL_NODE_ENV} node --input-type=module - omi-runs expired claude:ggtintran`,
    );
  });

  it("embeds the framework decision in the collector so the rule has one source", () => {
    expect(REMOTE_COLLECTOR).toContain("function decideExpiryProbe");
  });
});
