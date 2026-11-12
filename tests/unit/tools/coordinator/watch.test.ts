import { createWatchPoller, resetText } from "../../../../tools/coordinator/watch-core.ts";
import { buildSnapshot } from "../../../../tools/coordinator/watch-snapshot.ts";
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
import type { TasksRead } from "../../../../tools/coordinator/watch-tasks.ts";
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
  tasks: null,
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
  });

  it("homes each frame, erases every line and clears the remainder without a trailing newline", () => {
    const output = renderWatch(screen);
    expect(output.startsWith("\x1b[HWorkers")).toBe(true);
    expect(output).not.toContain("\x1b[2J");
    expect(output.endsWith("\x1b[K\x1b[J")).toBe(true);
    for (const line of output.slice(0, -ANSI.eraseRest.length).split("\n")) {
      expect(line.endsWith("\x1b[K")).toBe(true);
    }
  });

  it.each([1, 6, 19, 40, 160])(
    "fits all visible lines to %s columns including coloured errors",
    (columns) => {
      const output = renderWatch({
        ...screen,
        columns,
        workers: { available: false, reason: "offline ".repeat(40) },
        quota: { available: false, reason: "offline ".repeat(40) },
        confirming: true,
      });
      const plain = Object.values(ANSI).reduce((text, code) => text.replaceAll(code, ""), output);
      expect(plain.split("\n").every((line) => line.length <= columns)).toBe(true);
      expect(plain).toContain("…");
    },
  );

  it("prints one line per task above the workers, and nothing before the first read", () => {
    expect(renderWatch(screen)).not.toContain("Tasks");
    const tasks: TasksRead = {
      available: true,
      items: [
        {
          kind: "Issue",
          number: 152,
          title: "[OMI-074] t",
          state: "OPEN",
          status: "In Progress",
          priority: "P1",
          workType: "Task",
          planKey: "OMI-074",
          body: "",
          workflow: "Development",
          role: "Developer",
          area: null,
          milestone: null,
          blockers: [],
          blockersTruncated: false,
        },
      ],
      pulls: [],
      prompts: {},
    };
    const out = renderWatch({
      ...screen,
      tasks,
      workers: {
        available: true,
        latestLog: null,
        processes: [
          {
            pid: 1,
            tool: "claude",
            headless: true,
            elapsedSeconds: 5,
            task: "OMI-074",
            profile: "p",
          },
        ],
      },
    });
    expect(out).toContain("OMI-074 Development Work rework:0/2 Developer claude/p");
    expect(out.indexOf("Tasks")).toBeLessThan(out.indexOf("Workers"));
    expect(renderWatch({ ...screen, tasks: { available: false, reason: "gh\nfailed" } })).toContain(
      "GitHub unavailable: gh failed",
    );
  });

  it("validates interval input", () => {
    expect(watchInterval([])).toBe(5000);
    expect(watchInterval(["--interval", "0.5"])).toBe(500);
    for (const value of ["0", "-1", "NaN", "Infinity", "2147484"])
      expect(() => watchInterval(["--interval", value])).toThrow();
  });
});

afterEach(() => vi.useRealTimers());

function harness(run: Runner, signal?: AbortSignal, write?: (s: string) => void) {
  let resize: (() => void) | undefined;
  let columns = 160;
  let key: ((key: string) => void) | undefined;
  const writes: string[] = [];
  const raw: boolean[] = [];
  const terminal: WatchTerminal = {
    write: (s) => {
      write?.(s);
      writes.push(s);
    },
    setRawMode: (b) => {
      raw.push(b);
    },
    columns: () => columns,
    onResize: (listener) => {
      resize = listener;
      return () => {
        resize = undefined;
      };
    },
    onKey: (listener) => {
      key = listener;
      return () => {
        key = undefined;
      };
    },
  };
  const done = runWatch({
    run,
    ...(signal ? { signal } : {}),
    terminal,
    intervalMs: 5000,
    target: { viaWslExe: true, distro: "test", repoDir: "/test" },
    profiles,
    settings: QUOTA_SETTINGS,
  });
  return {
    writes,
    raw,
    key: (s: string) => key?.(s),
    done,
    resize: (width: number) => {
      columns = width;
      resize?.();
    },
    hasListeners: () => key !== undefined || resize !== undefined,
  };
}

const isQuota = (c: Command) => c.input?.includes("account/rateLimits/read") === true;
const isTasks = (c: Command) => c.file === "gh";
const isWorkers = (c: Command) => !isQuota(c) && !isTasks(c);

describe("watch polling and terminal lifecycle", () => {
  it.each(["q", "\u0003", "abort", "already aborted"])(
    "restores the terminal on %s",
    async (exit) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      if (exit === "already aborted") controller.abort();
      const h = harness(() => new Promise(() => {}), controller.signal);
      expect(h.writes[0]).toBe(`${ANSI.enter}${ANSI.hide}`);
      if (exit === "abort") controller.abort();
      else if (exit !== "already aborted") h.key(exit);
      await h.done;
      expect(h.raw).toEqual([true, false]);
      expect(h.writes.at(-1)).toBe(`${ANSI.reset}${ANSI.exit}${ANSI.show}`);
      expect(h.hasListeners()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("redraws immediately at the resized width and removes the resize listener on exit", async () => {
    vi.useFakeTimers();
    const h = harness(() => new Promise(() => {}));
    const before = h.writes.length;
    h.resize(19);
    expect(h.writes).toHaveLength(before + 1);
    expect(h.writes.at(-1)).toBe(renderWatch({ ...screen, workers: null, columns: 19 }));
    h.key("q");
    await h.done;
    const stopped = h.writes.length;
    h.resize(80);
    expect(h.writes).toHaveLength(stopped);
  });

  it.each(["initial draw", "resize draw", "refresh draw"])(
    "restores the terminal after a failed %s",
    async (failure) => {
      vi.useFakeTimers();
      let broken = failure === "initial draw";
      const h = harness(
        () =>
          failure === "refresh draw"
            ? Promise.resolve({ code: 127, stdout: "", stderr: "offline" })
            : new Promise(() => {}),
        undefined,
        (text) => {
          if (broken && text.startsWith(ANSI.clear)) throw new Error("draw failed");
        },
      );
      const rejected = expect(h.done).rejects.toThrow("failed");
      if (failure === "refresh draw") broken = true;
      if (failure === "resize draw") {
        broken = true;
        h.resize(40);
      }
      await rejected;
      expect(h.raw).toEqual([true, false]);
      expect(h.writes.at(-1)).toBe(`${ANSI.reset}${ANSI.exit}${ANSI.show}`);
      expect(h.hasListeners()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retries WSL errors, polls workers at interval and quota at 5 minutes without probing", async () => {
    vi.useFakeTimers();
    const commands: Command[] = [];
    const h = harness((c) => {
      commands.push(c);
      return Promise.resolve({ code: 127, stdout: "", stderr: "offline" });
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(commands.filter(isWorkers)).toHaveLength(4);
    expect(commands.filter(isQuota)).toHaveLength(1);
    expect(commands.filter(isTasks)).toHaveLength(1); // GitHub is read once a minute, not every 5 s
    expect(h.writes.join("")).toContain("offline (retrying)");
    await vi.advanceTimersByTimeAsync(285000);
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
    expect(commands.filter(isWorkers)).toHaveLength(3);
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

it.each([9999, 10000])("shares reset display between terminal and web at %s", (resetsAt) => {
  const quota = quotaWith({ ...reading, fiveHour: { usedPercent: 96, resetsAt } });
  expect(resetText(resetsAt, screen.now, true)).toBeNull();
  expect(renderWatch({ ...screen, quota })).toContain("100% / 80%  reset ?");
  expect(
    buildSnapshot({ ...screen, quota }).quota.rows.find((row) => row.fiveHourLeft !== null),
  ).toMatchObject({ fiveHourLeft: 100, resetText: null });
});

it("catches onChange exceptions, releases busy flags and continues polling", async () => {
  vi.useFakeTimers();
  const errors: unknown[] = [];
  let broken = true;
  const changed = vi.fn(() => {
    if (broken) throw new Error("snapshot failed");
  });
  const poller = createWatchPoller({
    run: () => Promise.resolve({ code: 127, stdout: "", stderr: "offline" }),
    target: { viaWslExe: false, distro: "test", repoDir: "/test" },
    profiles,
    settings: QUOTA_SETTINGS,
    workerIntervalMs: 5000,
    quotaIntervalMs: 1,
    onChange: changed,
    onError: (e) => {
      errors.push(e);
    },
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(errors).toHaveLength(2);
  expect(poller.probing).toBe(false);
  broken = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(changed).toHaveBeenCalledTimes(3);
  poller.probe();
  await vi.advanceTimersByTimeAsync(0);
  expect(poller.quota?.available).toBe(false);
  poller.stop();
  expect(vi.getTimerCount()).toBe(0);
});
