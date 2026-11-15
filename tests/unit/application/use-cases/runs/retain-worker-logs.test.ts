import { describe, expect, it } from "vitest";
import type { WorkerLogStore } from "../../../../../src/application/ports/worker-log-store.ts";
import { retainWorkerLogs } from "../../../../../src/application/use-cases/runs/retain-worker-logs.ts";
import type {
  ArchivedLog,
  WorkerLog,
} from "../../../../../src/domain/runs/log-retention-policy.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const HOUR = 3_600_000;
const SETTINGS = { recentMinutes: 30, archiveMaxBytes: 1000, archiveMaxAgeDays: 30 };

const log = (name: string, taskId: string, profile: string | null, ageMs: number): WorkerLog => ({
  name,
  taskId,
  profile,
  size: 10,
  mtimeMs: NOW - ageMs,
  running: false,
});

function fakeStore(root: WorkerLog[], archive: ArchivedLog[] = []) {
  const calls: string[] = [];
  const store: WorkerLogStore = {
    list: () => Promise.resolve({ root, archive }),
    archive: (name) => {
      calls.push(`archive ${name}`);
      return Promise.resolve();
    },
    remove: (name) => {
      calls.push(`remove ${name}`);
      return Promise.resolve();
    },
  };
  return { store, calls };
}

describe("retainWorkerLogs", () => {
  it("archives the Done task's old logs, keeps the newest per profile and caps the archive", async () => {
    const { store, calls } = fakeStore(
      [
        log("t-1--a--1.jsonl", "t-1", "a", 9 * HOUR),
        log("t-1--a--2.jsonl", "t-1", "a", 8 * HOUR),
        log("t-2--b--1.jsonl", "t-2", "b", 9 * HOUR),
      ],
      [{ name: "old.gz", size: 5, mtimeMs: NOW - 40 * 24 * HOUR }],
    );
    const result = await retainWorkerLogs(
      { logs: store, now: () => NOW },
      { doneTasks: ["t-1"], settings: SETTINGS },
    );
    expect(calls).toEqual(["archive t-1--a--1.jsonl", "remove archive/old.gz"]);
    expect(result).toMatchObject({ archived: 1, removed: 1, kept: 1, dryRun: false });
  });

  it("changes nothing on a dry run but reports the plan", async () => {
    const { store, calls } = fakeStore([
      log("t-1--a--1.jsonl", "t-1", "a", 9 * HOUR),
      log("t-1--a--2.jsonl", "t-1", "a", 8 * HOUR),
    ]);
    const result = await retainWorkerLogs(
      { logs: store, now: () => NOW },
      { doneTasks: ["t-1"], settings: SETTINGS, dryRun: true },
    );
    expect(calls).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.decisions.map((d) => `${d.action} ${d.name}`)).toEqual([
      "archive t-1--a--1.jsonl",
      "keep t-1--a--2.jsonl",
    ]);
  });

  it("continues after one file fails and reports it", async () => {
    const { store } = fakeStore([
      log("t-1--a--1.jsonl", "t-1", "a", 9 * HOUR),
      log("t-1--a--2.jsonl", "t-1", "a", 8 * HOUR),
      log("t-1--a--3.jsonl", "t-1", "a", 7 * HOUR),
    ]);
    const failing: WorkerLogStore = {
      ...store,
      archive: (name) =>
        name === "t-1--a--1.jsonl" ? Promise.reject(new Error("disk")) : Promise.resolve(),
    };
    const result = await retainWorkerLogs(
      { logs: failing, now: () => NOW },
      { doneTasks: ["t-1"], settings: SETTINGS },
    );
    expect(result).toMatchObject({ archived: 1, failed: ["t-1--a--1.jsonl"] });
  });
});
