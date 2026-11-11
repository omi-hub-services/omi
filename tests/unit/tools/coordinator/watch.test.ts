import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUOTA_SETTINGS,
  type WorkerProfile,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import {
  localTime,
  type QuotaReading,
  type QuotaReport,
} from "../../../../tools/coordinator/quota.ts";
import {
  ANSI,
  renderWatch,
  runWatch,
  watchInterval,
  type WatchScreen,
  type WatchTerminal,
} from "../../../../tools/coordinator/watch.ts";

const profiles: readonly WorkerProfile[] = [
  { tool: "claude", profile: "test", sharesCoordinatorAccount: false },
  { tool: "codex", profile: "other", sharesCoordinatorAccount: false },
];
const reading: QuotaReading = {
  source: "claude-log",
  observedAt: 10000,
  fiveHour: { usedPercent: 95, resetsAt: 14400 },
  sevenDay: { usedPercent: 20, resetsAt: null },
  limited: false,
  status: "allowed",
  planType: null,
  resetCredits: null,
  modelWindows: [],
};
const screen: WatchScreen = {
  workers: { available: true, processes: [], latestLog: null },
  quota: null,
  now: 10000,
  settings: QUOTA_SETTINGS,
  profiles,
};
const quotaWith = (r: QuotaReading): QuotaReport => ({
  available: true,
  now: 10000,
  profiles: [
    {
      ...profiles[0],
      tool: "claude",
      profile: "test",
      sharesCoordinatorAccount: false,
      reading: r,
      note: null,
    },
  ],
});

describe("watch rendering", () => {
  it("shows all worker fields, completed grey and errors/limits red", () => {
    const p = {
      pid: 4121,
      tool: "claude" as const,
      headless: true,
      elapsedSeconds: 1092,
      task: "OMI-004",
      profile: "test",
      model: "opus-5-5",
      effort: "high",
      log: {
        numTurns: 37,
        lastAction: "Bash npm run check",
        finished: true,
        isError: false,
        limited: false,
      },
    };
    const rendered = renderWatch({
      ...screen,
      workers: {
        available: true,
        latestLog: null,
        processes: [
          p,
          { ...p, pid: 4122, log: { ...p.log, isError: true } },
          { ...p, pid: 4123, log: { ...p.log, finished: false, limited: true } },
        ],
      },
    });
    expect(rendered).toContain(
      `${ANSI.grey}OMI-004  claude test  opus-5-5 high  pid 4121  18m12s  turn 37  → Bash npm run check${ANSI.reset}`,
    );
    expect(rendered).toContain(`${ANSI.red}OMI-004`);
    expect(rendered.split(ANSI.red)).toHaveLength(3);
  });

  it("shows quota for every configured profile, thresholds, local reset and aging", () => {
    const output = renderWatch({ ...screen, quota: quotaWith(reading) });
    expect(output).toContain(
      `${ANSI.yellow}  claude test  5% / 80%  reset ${localTime(14400).slice(11, 16)}  live`,
    );
    expect(output).toContain("codex other  ? / ?");
    expect(renderWatch({ ...screen, now: 11801, quota: quotaWith(reading) })).toContain(
      `${ANSI.yellow}${ANSI.dim}`,
    );
    expect(renderWatch({ ...screen, now: 11800, quota: quotaWith(reading) })).not.toContain(
      ANSI.dim,
    );
    expect(
      renderWatch({
        ...screen,
        quota: quotaWith({ ...reading, fiveHour: { usedPercent: 90, resetsAt: null } }),
      }),
    ).not.toContain(ANSI.yellow);
    expect(
      renderWatch({
        ...screen,
        quota: quotaWith({
          ...reading,
          fiveHour: null,
          sevenDay: { usedPercent: 91, resetsAt: null },
        }),
      }),
    ).toContain(ANSI.yellow);
  });

  it.each([9999, 10000])(
    "restores both windows to 100%% without yellow at/past reset %s",
    (resetsAt) => {
      const output = renderWatch({
        ...screen,
        quota: quotaWith({
          ...reading,
          fiveHour: { usedPercent: 96, resetsAt },
          sevenDay: { usedPercent: 99, resetsAt },
        }),
      });
      expect(output).toContain("claude test  100% / 100%");
      expect(output).not.toContain(ANSI.yellow);
    },
  );

  it("shows the weekly share left per model when the reading has one", () => {
    const withModel = {
      ...reading,
      modelWindows: [{ model: "Fable", usedPercent: 1, resetsAt: null }],
    };
    const rendered = renderWatch({ ...screen, quota: quotaWith(withModel) });
    expect(rendered).toContain("5% / 80%  Fable 99%");
    expect(renderWatch({ ...screen, quota: quotaWith(reading) })).not.toContain("Fable");
  });

  it("keeps a pending low window yellow when only the other window has reset", () => {
    const output = renderWatch({
      ...screen,
      quota: quotaWith({
        ...reading,
        fiveHour: { usedPercent: 96, resetsAt: screen.now - 1 },
        sevenDay: { usedPercent: 99, resetsAt: screen.now + 1 },
      }),
    });
    expect(output).toContain(`${ANSI.yellow}  claude test  100% / 1%`);
  });

  it("shows the reset in local HH:MM independently of the machine's time zone", () => {
    // Construct a local wall-clock time rather than assuming a UTC offset.
    const resetsAt = new Date(2026, 10, 11, 11, 30).getTime() / 1000;
    const output = renderWatch({
      ...screen,
      now: resetsAt - 60,
      quota: quotaWith({ ...reading, fiveHour: { usedPercent: 50, resetsAt } }),
    });
    expect(output).toContain("reset 11:30");
    expect(output).not.toContain("(UTC)");
  });

  it("renders WSL errors, confirmations and sanitizes external text", () => {
    expect(
      renderWatch({ ...screen, workers: { available: false, reason: "offline\u001b[2J\nretry" } }),
    ).toContain("WSL unavailable: offline [2J retry (retrying)");
    expect(renderWatch({ ...screen, confirming: true })).toContain(
      "Haiku call per Claude profile. y/N",
    );
    expect(
      renderWatch({ ...screen, columns: 40 })
        .split("\n")
        .every((line) => line.length <= 40 || line.startsWith(ANSI.clear)),
    ).toBe(true);
  });

  it("validates interval input", () => {
    expect(watchInterval([])).toBe(5000);
    expect(watchInterval(["--interval", "0.5"])).toBe(500);
    for (const value of ["0", "-1", "NaN", "Infinity", "2147484"])
      expect(() => watchInterval(["--interval", value])).toThrow();
  });
});

afterEach(() => vi.useRealTimers());

function harness(run: Runner) {
  let key: ((key: string) => void) | undefined;
  const writes: string[] = [];
  const raw: boolean[] = [];
  const terminal: WatchTerminal = {
    write: (s) => {
      writes.push(s);
    },
    setRawMode: (b) => {
      raw.push(b);
    },
    columns: () => 160,
    onKey: (listener) => {
      key = listener;
      return () => {
        key = undefined;
      };
    },
  };
  const done = runWatch({
    run,
    terminal,
    intervalMs: 5000,
    target: { viaWslExe: true, distro: "test", repoDir: "/test" },
    profiles,
    settings: QUOTA_SETTINGS,
  });
  return { writes, raw, key: (s: string) => key?.(s), done };
}

const isQuota = (c: Command) => c.input?.includes("account/rateLimits/read") === true;

describe("watch polling and terminal lifecycle", () => {
  it("retries WSL errors, polls workers at interval and quota at 60s without probing", async () => {
    vi.useFakeTimers();
    const commands: Command[] = [];
    const h = harness((c) => {
      commands.push(c);
      return Promise.resolve({ code: 127, stdout: "", stderr: "offline" });
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(commands.filter((c) => !isQuota(c))).toHaveLength(4);
    expect(commands.filter(isQuota)).toHaveLength(1);
    expect(h.writes.join("")).toContain("offline (retrying)");
    await vi.advanceTimersByTimeAsync(45000);
    expect(commands.filter(isQuota)).toHaveLength(2);
    expect(commands.filter(isQuota).every((c) => c.args.at(-1)?.includes("omi-runs 0 "))).toBe(
      true,
    );
    h.key("q");
    await h.done;
    expect(h.raw).toEqual([true, false]);
    expect(h.writes.at(-1)).toContain(ANSI.show);
    expect(commands.every((c) => c.signal?.aborted)).toBe(true);
    const count = commands.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(commands).toHaveLength(count);
  });

  it("requires p then y; no/Enter cancels and slow quota never blocks workers or q", async () => {
    vi.useFakeTimers();
    const commands: Command[] = [];
    let finishQuota: ((r: { code: number; stdout: string; stderr: string }) => void) | undefined;
    const h = harness((c) => {
      commands.push(c);
      return isQuota(c)
        ? new Promise((resolve) => {
            finishQuota = resolve;
          })
        : Promise.resolve({ code: 0, stdout: "@@ps\n@@log\n", stderr: "" });
    });
    h.key("p");
    h.key("\r");
    h.key("y");
    expect(commands.filter(isQuota)).toHaveLength(1);
    h.key("p");
    h.key("n");
    h.key("p");
    h.key("y"); // queued until the free read finishes
    await vi.advanceTimersByTimeAsync(10000);
    expect(commands.filter((c) => !isQuota(c))).toHaveLength(3);
    finishQuota?.({ code: 0, stdout: "", stderr: "" });
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.filter(isQuota)).toHaveLength(2);
    expect(commands.filter(isQuota).at(-1)?.args.at(-1)).toContain("omi-runs 1 ");
    h.key("q");
    await h.done;
    expect(h.raw.at(-1)).toBe(false);
    expect(h.writes.at(-1)).toContain(ANSI.show);
    finishQuota?.({ code: 0, stdout: "", stderr: "" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.writes.at(-1)).toContain(ANSI.show);
  });
});
