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
import { loadTemplate } from "../../../../tools/coordinator/watch-workflow.ts";
import {
  openCandidates,
  openWindow,
  parseWatchWebArgs,
  WINDOW_SIZE,
} from "../../../../tools/coordinator/watch-web.ts";
import type { PromptInfo, TasksRead } from "../../../../tools/coordinator/watch-tasks.ts";
import type { WorkerProcess } from "../../../../tools/coordinator/wsl-workers.ts";

const NOW = 100_000;
const profiles: readonly WorkerProfile[] = [
  { tool: "codex", profile: "other", sharesCoordinatorAccount: false },
  { tool: "claude", profile: "test", sharesCoordinatorAccount: false },
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
  profiles: [{ tool: "claude", profile: "test", reading: r, note }] as never,
});
const worker = (over: Partial<WorkerProcess> = {}): WorkerProcess => ({
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
  ...over,
});
const prompt = (step: string | null, role = "developer"): PromptInfo => ({
  skills: ["minimal-change"],
  rules: ["project-baseline", "evidence-and-tests"],
  mandatoryRules: ["project-baseline"],
  header: step === null ? null : { workflow: "feature", step, role },
});
const tasksRead = async (
  planKeys: string[],
  prompts: Record<string, PromptInfo | null> = {},
  workflow: string | null = "feature",
): Promise<TasksRead> => ({
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
    workflow,
    role: "Developer",
    area: null,
    milestone: null,
    blockers: [],
    blockersTruncated: false,
  })),
  pulls: [],
  prompts,
  templates: workflow === null ? {} : { [workflow]: await loadTemplate(workflow) },
});
const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  workers: { available: true, processes: [], latestLog: null },
  tasks: null,
  quota: null,
  now: NOW,
  settings: QUOTA_SETTINGS,
  profiles,
  ...over,
});

describe("buildSnapshot: the repo's data in the shared WatchSnapshot contract", () => {
  it("is loading before any read: no cards, no 0%, every configured profile unknown", () => {
    const s = buildSnapshot(input({ workers: null }));
    expect(s.board).toBe("loading");
    expect(s.tasks).toEqual([]);
    expect(s.quota.state).toBe("loading");
    expect(s.quota.rows.map((r) => `${r.tool}/${r.profile}`)).toEqual([
      "claude/test",
      "codex/other",
    ]);
    expect(s.quota.rows.every((r) => r.fiveHourLeft === null && r.severity === "unknown")).toBe(
      true,
    );
    expect(s.generatedAt).toBe(new Date(NOW * 1000).toISOString());
    expect(s.schemaVersion).toBeGreaterThan(0);
  });

  it("draws the task from its template and puts the QA worker at verify, not at implement", async () => {
    const s = buildSnapshot(
      input({
        tasks: await tasksRead(["OMI-004"], { "OMI-004": prompt("verify", "qa") }),
        workers: { available: true, latestLog: null, processes: [worker()] },
      }),
    );
    expect(s.board).toBe("ok");
    const [card] = s.tasks;
    expect(card).toMatchObject({
      planKey: "OMI-004",
      issueNumber: 100,
      workflow: "feature",
      step: "verify",
      role: "qa",
      runStatus: "running",
      who: {
        executor: "claude",
        profileId: "test",
        model: "opus-5-5",
        effort: "high",
        startedAt: null,
        step: "verify",
        role: "qa",
        elapsedSeconds: 1092,
      },
    });
    expect(card?.layout.nodes.map((n) => n.id)).toEqual([
      "analyze",
      "scope-approved",
      "implement",
      "verify",
      "review",
      "ready-to-merge",
    ]);
    expect(card?.layout.nodes.filter((n) => n.current).map((n) => n.id)).toEqual(["verify"]);
    expect(card?.layout.nodes.find((n) => n.id === "implement")?.state).toBe("done");
    expect(card?.layout.template.text).toBe("feature");
  });

  it("says unknown for the step and role of a running worker whose prompt has no header", async () => {
    const s = buildSnapshot(
      input({
        tasks: await tasksRead(["OMI-004"], { "OMI-004": prompt(null) }),
        workers: { available: true, latestLog: null, processes: [worker()] },
      }),
    );
    expect(s.tasks[0]?.who).toMatchObject({ step: null, role: null });
  });

  it("gives one card per worker with its own step: developer, QA and reviewer side by side", async () => {
    const s = buildSnapshot(
      input({
        tasks: await tasksRead(["OMI-004", "OMI-005", "OMI-006"], {
          "OMI-004": prompt("implement"),
          "OMI-005": prompt("verify", "qa"),
          "OMI-006": prompt("review", "reviewer"),
        }),
        workers: {
          available: true,
          latestLog: null,
          processes: [
            worker({ task: "OMI-004" }),
            worker({ pid: 2, task: "OMI-005" }),
            worker({ pid: 3, task: "OMI-006" }),
          ],
        },
      }),
    );
    expect(s.tasks.map((c) => [c.planKey, c.who?.step, c.who?.role])).toEqual([
      ["OMI-004", "implement", "developer"],
      ["OMI-005", "verify", "qa"],
      ["OMI-006", "review", "reviewer"],
    ]);
  });

  it("carries the loaded skills and rules, which rules are mandatory, and the skill check", async () => {
    const s = buildSnapshot(
      input({
        tasks: await tasksRead(["OMI-004"], { "OMI-004": prompt("implement") }),
        workers: { available: true, latestLog: null, processes: [worker()] },
      }),
    );
    const card = s.tasks[0];
    expect(card?.loaded).toEqual({
      skills: ["minimal-change"],
      rules: ["project-baseline", "evidence-and-tests"],
      mandatoryRules: ["project-baseline"],
    });
    expect(card?.skillCheck?.missing).toEqual(["test-driven-development"]);
  });

  it("has no worker and a hold on the card of a task that waits for the PO or is blocked", async () => {
    const waiting = await tasksRead(["OMI-004", "OMI-005"]);
    if (!waiting.available) throw new Error("unavailable");
    const [a, b] = waiting.items;
    if (a === undefined || b === undefined) throw new Error("no items");
    const s = buildSnapshot(
      input({
        tasks: {
          ...waiting,
          items: [
            { ...a, comments: [{ author: "minibox-claude-code", body: "**WAITING-PO:** decide" }] },
            { ...b, blockers: [{ number: 9, state: "OPEN" }] },
          ],
        },
      }),
    );
    expect(s.tasks.map((c) => [c.hold, c.who, c.runStatus])).toEqual([
      [{ kind: "waiting-po" }, null, "waiting_approval"],
      [{ kind: "blocked", by: [9] }, null, "blocked"],
    ]);
    expect(s.tasks.map((c) => c.layout.tone)).toEqual(["waiting", "blocked"]);
  });

  it("draws no diagram and says why when the template is unavailable", async () => {
    const s = buildSnapshot(input({ tasks: await tasksRead(["OMI-004"], {}, "nonexistent") }));
    const card = s.tasks[0];
    expect(card?.workflow).toBeNull();
    expect(card?.layout.nodes).toEqual([]);
    expect(card?.notes.join(" ")).toContain("nonexistent");
  });

  it("keeps the GitHub failure as board unavailable with no cards, and strips control characters", async () => {
    const s = buildSnapshot(input({ tasks: { available: false, reason: "gh\u001b[2J\nfailed" } }));
    expect(s.board).toBe("unavailable");
    expect(s.tasks).toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/\\u001b|\\n/);
    const ok = await tasksRead(["OMI-004"]);
    if (!ok.available) throw new Error("unavailable");
    const [only] = ok.items;
    if (only === undefined) throw new Error("no item");
    const dirty = buildSnapshot(
      input({ tasks: { ...ok, items: [{ ...only, title: "ti\u001b[2Jtle\nx" }] } }),
    );
    expect(dirty.tasks[0]?.title).toBe("ti [2Jtle x");
  });

  it("reports workers that cannot be read as an unknown worker state, never as no worker", async () => {
    const s = buildSnapshot(
      input({
        tasks: await tasksRead(["OMI-004"]),
        workers: { available: false, reason: "off\nline" },
      }),
    );
    expect(s.tasks[0]?.who).toBeNull();
    expect(s.tasks[0]?.notes.join(" ")).toContain("workers unreadable: WSL unavailable: off line");
  });

  it("is JSON-serialisable and does not mutate its input", async () => {
    const i = input({
      tasks: await tasksRead(["OMI-004"], { "OMI-004": prompt("implement") }),
      workers: { available: true, latestLog: null, processes: [worker()] },
      quota: quotaWith(reading),
    });
    const before = JSON.stringify(i);
    const s = buildSnapshot(i);
    expect(JSON.stringify(i)).toBe(before);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("buildSnapshot: quota rows", () => {
  it("computes % left, the five-hour reset and severity, Claude rows before Codex rows", () => {
    const s = buildSnapshot(input({ quota: quotaWith(reading, "usage api: HTTP 500") }));
    expect(s.quota.state).toBe("ok");
    expect(s.quota.rows[0]).toEqual({
      tool: "claude",
      profile: "test",
      fiveHourLeft: 5,
      sevenDayLeft: 80,
      resetText: localTime(NOW + 3600).slice(11, 16),
      severity: "low",
      freshness: "fresh",
      note: "usage api: HTTP 500",
    });
    // the Codex profile has no entry in the report
    expect(s.quota.rows[1]).toEqual({
      tool: "codex",
      profile: "other",
      fiveHourLeft: null,
      sevenDayLeft: null,
      resetText: null,
      severity: "unknown",
      freshness: "unknown",
      note: "unavailable",
    });
  });

  it("is critical when the limit is reached or a window is under half its threshold", () => {
    const limited = buildSnapshot(input({ quota: quotaWith({ ...reading, limited: true }) }));
    expect(limited.quota.rows[0]?.severity).toBe("critical");
    const nearly = buildSnapshot(
      input({
        quota: quotaWith({ ...reading, fiveHour: { usedPercent: 96, resetsAt: NOW + 60 } }),
      }),
    );
    expect(nearly.quota.rows[0]?.severity).toBe("critical");
    const fine = buildSnapshot(
      input({
        quota: quotaWith({ ...reading, fiveHour: { usedPercent: 50, resetsAt: NOW + 60 } }),
      }),
    );
    expect(fine.quota.rows[0]?.severity).toBe("ok");
  });

  it("treats a passed reset as a full window with no reset time", () => {
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
    expect(s.quota.rows[0]).toMatchObject({
      fiveHourLeft: 100,
      sevenDayLeft: null,
      resetText: null,
      severity: "ok",
    });
  });

  it("flags a low 7d window, a stale reading and an unavailable quota read", () => {
    const low7 = buildSnapshot(
      input({
        quota: quotaWith({
          ...reading,
          fiveHour: null,
          sevenDay: { usedPercent: 91, resetsAt: null },
        }),
      }),
    );
    expect(low7.quota.rows[0]).toMatchObject({ sevenDayLeft: 9, severity: "low" });
    const stale = buildSnapshot(
      input({ quota: quotaWith({ ...reading, observedAt: NOW - 3600 }) }),
    );
    expect(stale.quota.rows[0]?.freshness).toBe("stale");
    const down = buildSnapshot(
      input({ quota: { available: false, reason: "wsl.exe missing\nx" } }),
    );
    expect(down.quota).toMatchObject({ state: "unavailable", reason: "wsl.exe missing x" });
    expect(down.quota.rows.every((r) => r.fiveHourLeft === null && r.severity === "unknown")).toBe(
      true,
    );
  });

  it("shows a reading with no windows as unknown, not as full", () => {
    const s = buildSnapshot(
      input({ quota: quotaWith({ ...reading, fiveHour: null, sevenDay: null }) }),
    );
    expect(s.quota.rows[0]).toMatchObject({
      fiveHourLeft: null,
      sevenDayLeft: null,
      severity: "unknown",
    });
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
