import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUOTA_SETTINGS,
  QUOTA_MIN_INTERVAL_MS,
  type WorkerProfile,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import { createWatchPoller } from "../../../../tools/coordinator/watch-core.ts";

const profiles: readonly WorkerProfile[] = [
  { tool: "claude", profile: "idle", sharesCoordinatorAccount: false },
  { tool: "claude", profile: "busy", sharesCoordinatorAccount: false },
];
const target = { viaWslExe: false, distro: "test", repoDir: "/test" };
const H = 3600;

const payload = (c: Command) => c.args.at(-1) ?? "";
const isQuota = (c: Command) => payload(c).includes("--input-type=module");
const reading = (observedAt: number) => ({
  source: "claude-usage-api",
  observedAt,
  fiveHour: { usedPercent: 30, resetsAt: observedAt + H },
  sevenDay: { usedPercent: 40, resetsAt: observedAt + 50 * H },
  status: "allowed",
  limited: false,
  modelWindows: [],
});

/** Fake WSL: `idle`'s token expired 8 h ago until a probe renews it; `busy`'s is valid. */
function fakeWsl(options: { probeRenews: boolean }) {
  const quotaCommands: string[] = [];
  let renewed = false;
  const run: Runner = (command) => {
    if (!isQuota(command)) return Promise.resolve({ code: 127, stdout: "", stderr: "offline" });
    quotaCommands.push(payload(command));
    const now = Math.floor(Date.now() / 1000);
    const probing = payload(command).includes(" expired ");
    if (probing && options.probeRenews) renewed = true;
    const rows: object[] = [{ kind: "now", now }];
    if (!probing || payload(command).includes("claude:busy"))
      rows.push({
        kind: "usage",
        profile: "busy",
        usage: { five_hour: { utilization: 20, resets_at: null }, seven_day: null, limits: null },
      });
    if (!probing || payload(command).includes("claude:idle")) {
      if (probing)
        rows.push({ kind: "expiry-probe", profile: "idle", expiresAt: (now - 8 * H) * 1000 });
      if (renewed) {
        rows.push({
          kind: "usage",
          profile: "idle",
          usage: { five_hour: { utilization: 10, resets_at: null }, seven_day: null, limits: null },
        });
      } else {
        rows.push(
          { kind: "expired", profile: "idle", expiresAt: (now - 8 * H) * 1000 },
          { kind: "error", tool: "claude-usage", profile: "idle", message: "token expired" },
          {
            kind: "cache",
            profile: "idle",
            reading: { ...reading(now - 9 * H), source: "claude-probe" },
          },
        );
      }
    }
    return Promise.resolve({
      code: 0,
      stdout: rows.map((r) => JSON.stringify(r)).join("\n"),
      stderr: "",
    });
  };
  return { run, quotaCommands };
}

function start(run: Runner) {
  const poller = createWatchPoller({
    run,
    target,
    profiles,
    settings: QUOTA_SETTINGS,
    workerIntervalMs: 60_000,
    quotaIntervalMs: QUOTA_MIN_INTERVAL_MS,
    onChange: () => undefined,
  });
  poller.start();
  return poller;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watch poller expiry probe (OMI-094)", () => {
  it("runs one probe for the expired profile only, then shows fresh data", async () => {
    vi.useFakeTimers();
    const wsl = fakeWsl({ probeRenews: true });
    const poller = start(wsl.run);
    await vi.advanceTimersByTimeAsync(0);
    expect(wsl.quotaCommands).toHaveLength(2);
    expect(wsl.quotaCommands[1]).toMatch(/ expired claude:idle$/);
    const idle = poller.quota?.available
      ? poller.quota.profiles.find((p) => p.profile === "idle")
      : undefined;
    expect(idle?.tokenExpiresAt).toBeNull();
    expect(idle?.reading?.source).toBe("claude-usage-api");
    expect(Math.floor(Date.now() / 1000) - (idle?.reading?.observedAt ?? 0)).toBeLessThan(60);
    poller.stop();
  });

  it("stays eligible after a cooldown refusal and probes once the collector allows it", async () => {
    vi.useFakeTimers();
    const modes: string[] = [];
    let expiredReads = 0;
    const run: Runner = (command) => {
      if (!isQuota(command)) return Promise.resolve({ code: 127, stdout: "", stderr: "offline" });
      const now = Math.floor(Date.now() / 1000);
      const probing = payload(command).includes(" expired ");
      modes.push(probing ? "expired" : "plain");
      const rows: object[] = [{ kind: "now", now }];
      if (probing && ++expiredReads >= 2) {
        rows.push(
          { kind: "expiry-probe", profile: "idle", expiresAt: (now - 8 * H) * 1000 },
          {
            kind: "usage",
            profile: "idle",
            usage: {
              five_hour: { utilization: 10, resets_at: null },
              seven_day: null,
              limits: null,
            },
          },
        );
      } else if (probing || expiredReads < 2) {
        // the shared cooldown refused: the collector reports expiry but did not probe
        rows.push(
          { kind: "expired", profile: "idle", expiresAt: (now - 8 * H) * 1000 },
          {
            kind: "cache",
            profile: "idle",
            reading: { ...reading(now - 9 * H), source: "claude-probe" },
          },
        );
      } else {
        rows.push({
          kind: "usage",
          profile: "idle",
          usage: { five_hour: { utilization: 10, resets_at: null }, seven_day: null, limits: null },
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: rows.map((r) => JSON.stringify(r)).join("\n"),
        stderr: "",
      });
    };
    const poller = createWatchPoller({
      run,
      target,
      profiles: profiles.slice(0, 1),
      settings: QUOTA_SETTINGS,
      workerIntervalMs: 60_000,
      quotaIntervalMs: QUOTA_MIN_INTERVAL_MS,
      onChange: () => undefined,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(modes).toEqual(["plain", "expired"]);
    await vi.advanceTimersByTimeAsync(QUOTA_MIN_INTERVAL_MS);
    // not recorded as probed, so the next poll asks again and the probe then runs
    expect(modes.filter((m) => m === "expired")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(QUOTA_MIN_INTERVAL_MS * 2);
    expect(modes.filter((m) => m === "expired")).toHaveLength(2);
    poller.stop();
  });

  it("does not probe when every token is valid", async () => {
    vi.useFakeTimers();
    const wsl = fakeWsl({ probeRenews: true });
    const poller = createWatchPoller({
      run: (c) =>
        wsl.run(c).then((r) => ({ ...r, stdout: r.stdout.replace(/.*"expired".*\n?/g, "") })),
      target,
      profiles: profiles.slice(1),
      settings: QUOTA_SETTINGS,
      workerIntervalMs: 60_000,
      onChange: () => undefined,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(wsl.quotaCommands).toHaveLength(1);
    expect(wsl.quotaCommands.some((c) => c.includes(" expired "))).toBe(false);
    poller.stop();
  });

  it("does not probe again for the same expiry after a probe that did not renew it", async () => {
    vi.useFakeTimers();
    const wsl = fakeWsl({ probeRenews: false });
    const poller = start(wsl.run);
    await vi.advanceTimersByTimeAsync(0);
    expect(wsl.quotaCommands).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(QUOTA_MIN_INTERVAL_MS * 3);
    // three more plain polls, no further expiry probe
    expect(wsl.quotaCommands.filter((c) => c.includes(" expired "))).toHaveLength(1);
    const idle = poller.quota?.available
      ? poller.quota.profiles.find((p) => p.profile === "idle")
      : undefined;
    expect(idle?.tokenExpiresAt).not.toBeNull();
    expect(idle?.note).toBe("usage api: token expired");
    poller.stop();
  });
});
