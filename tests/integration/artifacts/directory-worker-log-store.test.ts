import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retainWorkerLogs } from "../../../src/application/use-cases/runs/retain-worker-logs.ts";
import { createDirectoryWorkerLogStore } from "../../../src/infrastructure/artifacts/directory-worker-log-store.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const HOUR = 3_600_000;
const SETTINGS = { recentMinutes: 30, archiveMaxBytes: 1_000_000, archiveMaxAgeDays: 30 };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-logs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const put = (name: string, text: string, ageMs: number, where = dir): void => {
  mkdirSync(where, { recursive: true });
  const path = join(where, name);
  writeFileSync(path, text);
  utimesSync(path, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
};

describe("directory worker log store", () => {
  it("lists logs by task and profile, ignoring files that do not follow the naming", async () => {
    put("task-1--claude-a--20261112T010000.jsonl", "x", HOUR);
    put("task-1--prompt.md", "x", HOUR);
    put("stray.txt", "x", HOUR);
    put("old.jsonl.gz", "gz", HOUR, join(dir, "archive"));
    const listed = await createDirectoryWorkerLogStore({ directory: dir }).list();
    expect(listed.root.map((l) => [l.name, l.taskId, l.profile]).sort()).toEqual([
      ["task-1--claude-a--20261112T010000.jsonl", "task-1", "claude-a"],
      ["task-1--prompt.md", "task-1", null],
    ]);
    expect(listed.archive.map((a) => a.name)).toEqual(["old.jsonl.gz"]);
  });

  it("gzips a log into archive/ keeping its mtime, and removes the original", async () => {
    put("task-1--a--20261112T010000.jsonl", "line 1\nline 2\n", 9 * HOUR);
    const store = createDirectoryWorkerLogStore({ directory: dir });
    await store.archive("task-1--a--20261112T010000.jsonl");
    await store.archive("task-1--a--20261112T010000.jsonl"); // a re-run changes nothing
    const target = join(dir, "archive", "task-1--a--20261112T010000.jsonl.gz");
    expect(gunzipSync(readFileSync(target)).toString()).toBe("line 1\nline 2\n");
    expect(statSync(target).mtimeMs).toBeCloseTo(NOW - 9 * HOUR, -3);
    expect(existsSync(join(dir, "task-1--a--20261112T010000.jsonl"))).toBe(false);
  });

  it("removes a root or archive file and treats a missing one as done", async () => {
    put("task-1--x.md", "x", HOUR);
    put("a.gz", "gz", HOUR, join(dir, "archive"));
    const store = createDirectoryWorkerLogStore({ directory: dir });
    await store.remove("task-1--x.md");
    await store.remove("archive/a.gz");
    await store.remove("archive/a.gz");
    expect(existsSync(join(dir, "task-1--x.md"))).toBe(false);
    expect(existsSync(join(dir, "archive", "a.gz"))).toBe(false);
  });

  it.each(["../escape.md", "archive/../x", "a/b.md", ".."])(
    "refuses the unsafe name %s",
    async (name) => {
      const store = createDirectoryWorkerLogStore({ directory: dir });
      await expect(store.remove(name)).rejects.toThrow("INVALID_PATH");
      await expect(store.archive(name)).rejects.toThrow("INVALID_PATH");
    },
  );

  it("marks the logs of running workers", async () => {
    put("task-1--a--20261112T010000.jsonl", "x", HOUR);
    const store = createDirectoryWorkerLogStore({
      directory: dir,
      running: () => new Set(["task-1--a--20261112T010000.jsonl"]),
    });
    expect((await store.list()).root[0]?.running).toBe(true);
  });

  it("retains for real: archives Done logs, keeps running and newest, caps the archive", async () => {
    put("task-1--a--20261112T010000.jsonl", "old", 9 * HOUR);
    put("task-1--a--20261112T020000.jsonl", "newest", 8 * HOUR);
    put("task-1--b--20261112T030000.jsonl", "running", 9 * HOUR);
    put("task-1--prompt.md", "prompt", 9 * HOUR);
    put("task-2--c--20261112T040000.jsonl", "other task", 9 * HOUR);
    put("ancient.gz", "gz", 40 * 24 * HOUR, join(dir, "archive"));
    const logs = createDirectoryWorkerLogStore({
      directory: dir,
      running: () => new Set(["task-1--b--20261112T030000.jsonl"]),
    });

    const result = await retainWorkerLogs(
      { logs, now: () => NOW },
      { doneTasks: ["task-1"], settings: SETTINGS },
    );

    expect(result).toMatchObject({ archived: 2, removed: 1, failed: [] });
    const left = (await logs.list()).root.map((l) => l.name).sort();
    expect(left).toEqual([
      "task-1--a--20261112T020000.jsonl",
      "task-1--b--20261112T030000.jsonl",
      "task-2--c--20261112T040000.jsonl",
    ]);
    expect((await logs.list()).archive.map((a) => a.name).sort()).toEqual([
      "task-1--a--20261112T010000.jsonl.gz",
      "task-1--prompt.md.gz",
    ]);
  });
});
