import { describe, expect, it } from "vitest";
import {
  planLogRetention,
  type ArchivedLog,
  type LogRetentionSettings,
  type WorkerLog,
} from "../../../../src/domain/runs/log-retention-policy.ts";

const NOW = 1_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SETTINGS: LogRetentionSettings = {
  recentMinutes: 30,
  archiveMaxBytes: 1000,
  archiveMaxAgeDays: 30,
};

const log = (
  name: string,
  taskId: string,
  profile: string | null,
  ageMs = 5 * HOUR,
  extra: Partial<WorkerLog> = {},
): WorkerLog => ({
  name,
  taskId,
  profile,
  size: 100,
  mtimeMs: NOW - ageMs,
  running: false,
  ...extra,
});
const old = (name: string, ageMs: number, size = 100): ArchivedLog => ({
  name,
  size,
  mtimeMs: NOW - ageMs,
});
const plan = (root: WorkerLog[], archive: ArchivedLog[], ...done: string[]) =>
  planLogRetention({ now: NOW, root, archive }, new Set(done), SETTINGS).map(
    (d) => `${d.action} ${d.name}`,
  );

describe("planLogRetention", () => {
  it("archives the logs of a Done task and keeps the newest stream log of each profile", () => {
    expect(
      plan(
        [
          log("t-1--a--1.jsonl", "t-1", "a", 9 * HOUR),
          log("t-1--a--2.jsonl", "t-1", "a", 8 * HOUR),
          log("t-1--prompt.md", "t-1", null),
        ],
        [],
        "t-1",
      ),
    ).toEqual(["archive t-1--a--1.jsonl", "keep t-1--a--2.jsonl", "archive t-1--prompt.md"]);
  });

  it("picks the newest log per profile across all tasks, so another task's newer log wins", () => {
    expect(
      plan(
        [log("t-1--a--1.jsonl", "t-1", "a", 9 * HOUR), log("t-2--a--1.jsonl", "t-2", "a", HOUR)],
        [],
        "t-1",
      ),
    ).toEqual(["archive t-1--a--1.jsonl"]);
  });

  it("keeps a running worker's log and a log written within the recent window", () => {
    expect(
      plan(
        [
          log("t-1--a--1.jsonl", "t-1", "a", 9 * HOUR),
          log("t-1--b--1.jsonl", "t-1", "b", 9 * HOUR, { running: true }),
          log("t-1--c--1.jsonl", "t-1", "c", 9 * HOUR),
          log("t-1--c--2.jsonl", "t-1", "c", 10 * 60_000),
          log("t-1--d.err", "t-1", null, 10 * 60_000),
        ],
        [],
        "t-1",
      ),
    ).toEqual([
      "keep t-1--a--1.jsonl",
      "keep t-1--b--1.jsonl",
      "archive t-1--c--1.jsonl",
      "keep t-1--c--2.jsonl",
      "keep t-1--d.err",
    ]);
  });

  it("never touches the logs of a task that is not Done", () => {
    expect(
      plan([log("t-2--a--1.jsonl", "t-2", null), log("t-2--x.md", "t-2", null)], [], "t-1"),
    ).toEqual([]);
  });

  it("drops archive files older than the age limit, then the oldest until the size fits", () => {
    expect(
      plan(
        [],
        [
          old("ancient.gz", 40 * DAY),
          old("a.gz", 3 * DAY, 400),
          old("b.gz", 2 * DAY, 400),
          old("c.gz", DAY, 400),
        ],
      ),
    ).toEqual(["delete archive/ancient.gz", "delete archive/a.gz"]);
  });

  it("leaves an archive within both limits alone", () => {
    expect(plan([], [old("a.gz", DAY, 500), old("b.gz", HOUR, 500)])).toEqual([]);
  });
});
