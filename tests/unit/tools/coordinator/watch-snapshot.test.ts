import { describe, expect, it } from "vitest";
import {
  QUOTA_SETTINGS,
  type WorkerProfile,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import {
  localTime,
  type QuotaReading,
  type QuotaReport,
} from "../../../../tools/coordinator/quota.ts";
import { windowsLow, workerTone } from "../../../../tools/coordinator/watch-core.ts";
import { buildSnapshot, type SnapshotInput } from "../../../../tools/coordinator/watch-snapshot.ts";
import {
  openCandidates,
  openWindow,
  parseWatchWebArgs,
  WINDOW_SIZE,
} from "../../../../tools/coordinator/watch-web.ts";
import type { TasksRead } from "../../../../tools/coordinator/watch-tasks.ts";
import type { WorkerProcess } from "../../../../tools/coordinator/wsl-workers.ts";

const NOW = 100_000;
const profiles: readonly WorkerProfile[] = [
  { tool: "claude", profile: "test", sharesCoordinatorAccount: false },
  { tool: "codex", profile: "other", sharesCoordinatorAccount: false },
];
const reading: QuotaReading = {
  source: "claude-usage-api",
  observedAt: NOW - 90,
  fiveHour: { usedPercent: 95, resetsAt: NOW + 3600 },
  sevenDay: { usedPercent: 20, resetsAt: NOW + 86400 },
  limited: false,
  status: "allowed",
  planType: null,
  resetCredits: null,
  modelWindows: [{ model: "Fable", usedPercent: 1, resetsAt: NOW + 86400 }],
};
const quotaWith = (r: QuotaReading | null, note: string | null = null): QuotaReport => ({
  available: true,
  now: NOW,
  profiles: [{ ...profiles[0], tool: "claude", profile: "test", reading: r, note }] as never,
});
const process1: WorkerProcess = {
  pid: 4121,
  tool: "claude",
  headless: true,
  elapsedSeconds: 1092.7,
  task: "OMI-004",
  profile: "test",
  model: "opus-5-5",
  effort: "high",
  log: {
    numTurns: 37,
    lastAction: "Bash npm run check",
    finished: false,
    isError: false,
    limited: false,
  },
};
const log1 = {
  numTurns: 37,
  lastAction: "Bash npm run check",
  finished: false,
  isError: false,
  limited: false,
};
const tasksRead = (planKeys: string[]): TasksRead => ({
  available: true,
  items: planKeys.map((planKey, i) => ({
    kind: "Issue",
    number: 100 + i,
    title: `[${planKey}] t`,
    state: "OPEN",
    status: "In Progress",
    priority: "P1",
    workType: "Task",
    planKey,
    body: "",
    workflow: "Development",
    role: "Developer",
    area: null,
    milestone: null,
    blockers: [],
    blockersTruncated: false,
  })),
  pulls: [],
  prompts: Object.fromEntries(planKeys.map((k) => [k, { skills: ["minimal-change"], rules: [] }])),
});
const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  workers: { available: true, processes: [], latestLog: null },
  tasks: null,
  quota: null,
  probing: false,
  now: NOW,
  settings: QUOTA_SETTINGS,
  profiles,
  ...over,
});

describe("buildSnapshot", () => {
  it("reports loading before any read, with every configured profile", () => {
    const s = buildSnapshot(input({ workers: null }));
    expect(s.tasks).toEqual({ state: "loading" });
    expect(s.quota.state).toBe("loading");
    expect(s.quota.profiles.map((p) => p.profile)).toEqual(["test", "other"]);
    expect(s.quota.profiles[0]?.note).toBe("loading");
    expect(s.generatedAt).toBe(NOW);
  });

  it("builds the Tasks section from the GitHub read and the workers", () => {
    const s = buildSnapshot(
      input({
        tasks: tasksRead(["OMI-004", "OMI-005", "OMI-006"]),
        workers: {
          available: true,
          latestLog: null,
          processes: [
            process1,
            { ...process1, pid: 2, task: "OMI-005", log: { ...log1, finished: true } },
            { ...process1, pid: 3, task: "OMI-006", log: { ...log1, isError: true } },
          ],
        },
      }),
    );
    if (s.tasks.state !== "ok") throw new Error("expected ok");
    const [a, b, c] = s.tasks.items;
    expect(a).toMatchObject({
      planKey: "OMI-004",
      step: "Work",
      role: "Developer",
      worker: {
        pid: 4121,
        tool: "claude",
        profile: "test",
        model: "opus-5-5",
        effort: "high",
        elapsedSeconds: 1092,
        turns: 37,
        lastAction: "Bash npm run check",
        tone: "normal",
      },
    });
    expect([b?.worker?.tone, c?.worker?.tone]).toEqual(["done", "error"]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("strips control characters from external strings", () => {
    const s = buildSnapshot(input({ tasks: { available: false, reason: "gh\u001b[2J\nfailed" } }));
    expect(JSON.stringify(s)).not.toMatch(/\\u001b|\\n/);
    expect(s.tasks).toEqual({ state: "unavailable", reason: "gh [2J failed" });
    const w = buildSnapshot(
      input({ tasks: tasksRead(["OMI-004"]), workers: { available: false, reason: "off\nline" } }),
    );
    expect(JSON.stringify(w.tasks)).toContain("workers unreadable: WSL unavailable: off line");
  });

  it("computes % left, thresholds, local reset, model windows and reading age", () => {
    const s = buildSnapshot(input({ quota: quotaWith(reading, "usage api: HTTP 500") }));
    const p = s.quota.profiles[0];
    expect(s.quota.state).toBe("ok");
    expect(p?.note).toBe("usage api: HTTP 500");
    expect(p?.reading).toEqual({
      source: "claude-usage-api",
      observedAt: NOW - 90,
      ageSeconds: 90,
      fiveHour: { left: 5, low: true, resetText: localTime(NOW + 3600).slice(11, 16) },
      sevenDay: { left: 80, low: false, resetText: localTime(NOW + 86400).slice(5, 16) },
      models: [{ model: "Fable", left: 99, resetText: localTime(NOW + 86400).slice(5, 16) }],
      limited: false,
      low: true,
    });
    // the Codex profile has no entry in the report
    expect(s.quota.profiles[1]).toEqual({
      tool: "codex",
      profile: "other",
      reading: null,
      note: "unavailable",
    });
  });

  it("treats a passed reset as a full window with no reset time, and unknown windows as not low", () => {
    const s = buildSnapshot(
      input({
        quota: quotaWith({
          ...reading,
          fiveHour: { usedPercent: 99, resetsAt: NOW },
          sevenDay: null,
          modelWindows: [],
        }),
      }),
    );
    expect(s.quota.profiles[0]?.reading).toMatchObject({
      fiveHour: { left: 100, low: false, resetText: null },
      sevenDay: null,
      models: [],
      low: false,
    });
  });

  it("flags a low 7d window and an unavailable quota read", () => {
    const low7 = buildSnapshot(
      input({
        quota: quotaWith({
          ...reading,
          fiveHour: null,
          sevenDay: { usedPercent: 91, resetsAt: null },
        }),
      }),
    );
    expect(low7.quota.profiles[0]?.reading).toMatchObject({
      sevenDay: { left: 9, low: true, resetText: null },
      low: true,
    });
    const down = buildSnapshot(
      input({ quota: { available: false, reason: "wsl.exe missing\nx" } }),
    );
    expect(down.quota).toMatchObject({ state: "unavailable", reason: "wsl.exe missing x" });
    expect(down.quota.profiles.every((q) => q.reading === null)).toBe(true);
  });

  it("carries the probing flag and the stale threshold; is JSON-serialisable", () => {
    const s = buildSnapshot(input({ probing: true }));
    expect(s.probing).toBe(true);
    expect(s.staleAfterSeconds).toBe(1800);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("does not mutate its input", () => {
    const i = input({ quota: quotaWith(reading) });
    const before = JSON.stringify(i);
    buildSnapshot(i);
    expect(JSON.stringify(i)).toBe(before);
  });
});

describe("shared colour rules", () => {
  it("workerTone and windowsLow follow the terminal watch rules", () => {
    const log = { numTurns: 1, lastAction: null, finished: false, isError: false, limited: false };
    expect(workerTone(null)).toBe("normal");
    expect(workerTone({ ...log, finished: true })).toBe("done");
    expect(workerTone({ ...log, finished: true, isError: true })).toBe("error");
    expect(workerTone({ ...log, limited: true })).toBe("error");
    expect(windowsLow(9.9, null, QUOTA_SETTINGS)).toBe(true);
    expect(windowsLow(10, 10, QUOTA_SETTINGS)).toBe(false);
    expect(windowsLow(null, 5, QUOTA_SETTINGS)).toBe(true);
    expect(windowsLow(null, null, QUOTA_SETTINGS)).toBe(false);
  });
});

describe("watch-web launch helpers", () => {
  const url = "http://127.0.0.1:4317";

  it("parses --port and --open and validates the port", () => {
    expect(parseWatchWebArgs([])).toEqual({ port: 4317, open: false });
    expect(parseWatchWebArgs(["--port", "5000", "--open"])).toEqual({ port: 5000, open: true });
    for (const bad of ["0", "70000", "abc", "1.5"])
      expect(() => parseWatchWebArgs(["--port", bad])).toThrow();
  });

  it("tries Edge as an app window first, then the default browser", () => {
    const c = openCandidates(url, "win32", ["C:\\edge.exe"]);
    expect(c[0]).toEqual({
      file: "msedge",
      args: [`--app=${url}`, `--window-size=${WINDOW_SIZE}`],
    });
    expect(c[1]?.file).toBe("C:\\edge.exe");
    expect(c.at(-1)).toEqual({ file: "cmd", args: ["/c", "start", "", url] });
    expect(openCandidates(url, "linux", []).map((l) => l.file)).toEqual([
      "msedge",
      "cmd.exe",
      "xdg-open",
    ]);
  });

  it("falls back down the list until one launch starts", async () => {
    const tried: string[] = [];
    const started = await openWindow(
      url,
      "win32",
      (l) => {
        tried.push(l.file);
        return Promise.resolve(l.file === "cmd");
      },
      () => true,
    );
    expect(started?.file).toBe("cmd");
    expect(tried[0]).toBe("msedge");
    expect(tried.at(-1)).toBe("cmd");
    expect(await openWindow(url, "linux", () => Promise.resolve(false))).toBeNull();
  });
});
