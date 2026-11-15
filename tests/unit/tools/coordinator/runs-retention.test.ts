import { describe, expect, it } from "vitest";
import type { RunsRetention } from "../../../../tools/coordinator/coordinator-settings.ts";
import {
  parseRunsListing,
  planRetention,
  retentionScript,
  type RunFile,
  type RunsListing,
} from "../../../../tools/coordinator/runs-retention.ts";

const NOW = 1_000_000;
const HOUR = 3600;
const DAY = 86400;
const SETTINGS: RunsRetention = { recentMinutes: 30, archiveMaxBytes: 1000, archiveMaxAgeDays: 30 };

const file = (name: string, ageSeconds = 5 * HOUR, size = 100, live = false): RunFile => ({
  name,
  size,
  mtime: NOW - ageSeconds,
  live,
});
const listing = (root: RunFile[], archive: RunFile[] = []): RunsListing => ({
  now: NOW,
  root,
  archive,
});
const plan = (l: RunsListing, ...tasks: string[]) =>
  planRetention(l, new Set(tasks), SETTINGS).map((d) => `${d.action} ${d.name}`);

describe("planRetention (root)", () => {
  it("archives the old files of the task and keeps the newest log of each profile", () => {
    const l = listing([
      file("omi-052-ggtintran-20261110-202514.jsonl", 9 * HOUR),
      file("omi-052-ggtintran-20261110-203511.jsonl", 8 * HOUR),
      file("omi-052-prompt.md"),
      file("omi-052-followup.md"),
      file("omi-007-minibox-20261110-203724.jsonl", 7 * HOUR),
    ]);
    expect(plan(l, "052")).toEqual([
      "archive omi-052-followup.md",
      "archive omi-052-ggtintran-20261110-202514.jsonl",
      "keep omi-052-ggtintran-20261110-203511.jsonl",
      "archive omi-052-prompt.md",
    ]);
  });

  it("reads packet-suffixed log names: newest per profile, older same-second sibling archived (OMI-113)", () => {
    const l = listing([
      file("omi-107-ggtintran-20261113-163149-verify-1-aaa111.jsonl", 9 * HOUR),
      file("omi-107-ggtintran-20261113-163149-review-1-bbb222.jsonl", 8 * HOUR),
      file("omi-107-codex-ggtintran-20261113-163149-review-1-ccc333.jsonl", 7 * HOUR),
    ]);
    expect(plan(l, "107")).toEqual([
      "keep omi-107-codex-ggtintran-20261113-163149-review-1-ccc333.jsonl",
      "keep omi-107-ggtintran-20261113-163149-review-1-bbb222.jsonl",
      "archive omi-107-ggtintran-20261113-163149-verify-1-aaa111.jsonl",
    ]);
  });

  it("picks the newest log per profile across all tasks, not only the selected ones", () => {
    const l = listing([
      file("omi-006-minibox-20261110-163807.jsonl", 20 * HOUR),
      file("omi-008-minibox-20261110-210546.jsonl", 10 * HOUR),
      file("omi-006-ggtintran-20261110-202108.jsonl", 12 * HOUR),
    ]);
    expect(plan(l, "006")).toEqual([
      "keep omi-006-ggtintran-20261110-202108.jsonl", // only log of its profile
      "archive omi-006-minibox-20261110-163807.jsonl", // omi-008 is newer for minibox
    ]);
    expect(plan(l, "008")).toEqual(["keep omi-008-minibox-20261110-210546.jsonl"]);
  });

  it("treats codex-<profile> and legacy (no profile) logs as profiles of their own", () => {
    const l = listing([
      file("omi-003-codex-ggtintran-20261110-222822.jsonl", 9 * HOUR),
      file("omi-003-codex-ggtintran-20261110-223945.jsonl", 8 * HOUR),
      file("omi-002-20261110-142459.jsonl", 30 * HOUR),
    ]);
    expect(plan(l, "002", "003")).toEqual([
      "keep omi-002-20261110-142459.jsonl",
      "archive omi-003-codex-ggtintran-20261110-222822.jsonl",
      "keep omi-003-codex-ggtintran-20261110-223945.jsonl",
    ]);
  });

  it("leaves a running worker's files and recently written files untouched", () => {
    const l = listing([
      file("omi-056-minibox-20261111-090000.jsonl", 2 * HOUR, 100, true),
      file("omi-056-minibox-20261111-090000.err", 2 * HOUR, 0, true),
      file("omi-056-minibox-20261111-080000.jsonl", 3 * HOUR),
      file("omi-056-prompt.md", 60),
      file("omi-056-current", 60),
      file("omi-056-resume.md", 29 * 60),
      file("omi-056-old.md", 31 * 60),
    ]);
    expect(plan(l, "056")).toEqual([
      "keep omi-056-current",
      "archive omi-056-minibox-20261111-080000.jsonl",
      "keep omi-056-minibox-20261111-090000.err",
      "keep omi-056-minibox-20261111-090000.jsonl",
      "archive omi-056-old.md",
      "keep omi-056-prompt.md",
      "keep omi-056-resume.md",
    ]);
  });

  it("archives old per-dispatch packet and codex-last files like logs, keeps recent ones (OMI-111)", () => {
    const l = listing([
      file("omi-057-prompt-verify-1.md", 9 * HOUR),
      file("omi-057-prompt-review-1.md", 9 * HOUR),
      file("omi-057-resume-review-1.md", 9 * HOUR),
      file("omi-057-codex-minibox-20261111-090000-last.md", 9 * HOUR),
      file("omi-057-prompt-review-2.md", 60),
      file("omi-057-prompt-review-2.md.tmp", 60),
    ]);
    expect(plan(l, "057")).toEqual([
      "archive omi-057-codex-minibox-20261111-090000-last.md",
      "archive omi-057-prompt-review-1.md",
      "keep omi-057-prompt-review-2.md",
      "keep omi-057-prompt-review-2.md.tmp",
      "archive omi-057-prompt-verify-1.md",
      "archive omi-057-resume-review-1.md",
    ]);
  });

  it("deletes empty .err and *-current, but archives a non-empty .err", () => {
    const l = listing([
      file("omi-050-20261110-145006.err", 5 * HOUR, 0),
      file("omi-050-current"),
      file("omi-051-20261110-152010.err", 5 * HOUR, 12),
    ]);
    expect(plan(l, "050", "051")).toEqual([
      "delete omi-050-20261110-145006.err",
      "delete omi-050-current",
      "archive omi-051-20261110-152010.err",
    ]);
  });

  it("ignores files of tasks that were not selected and files that are not task logs", () => {
    const l = listing([file("omi-009-prompt.md"), file("omi-notes.md")]);
    expect(plan(l, "052")).toEqual([]);
  });

  it("is idempotent: a second pass over its own result has nothing left to do", () => {
    const l = listing([
      file("omi-052-ggtintran-20261110-202514.jsonl", 9 * HOUR),
      file("omi-052-ggtintran-20261110-203511.jsonl", 8 * HOUR),
      file("omi-052-ggtintran-20261110-203511.err", 8 * HOUR, 0),
    ]);
    const after = listing([l.root[1] as RunFile]);
    expect(plan(after, "052")).toEqual(["keep omi-052-ggtintran-20261110-203511.jsonl"]);
  });
});

describe("planRetention (archive cap)", () => {
  const archived = (name: string, ageDays: number, size: number) => file(name, ageDays * DAY, size);

  it("drops files older than the age limit", () => {
    const l = listing([], [archived("a.gz", 31, 10), archived("b.gz", 29, 10)]);
    expect(plan(l)).toEqual(["delete archive/a.gz"]);
  });

  it("drops the oldest first until the archive fits the size limit", () => {
    const l = listing(
      [],
      [archived("c.gz", 1, 400), archived("a.gz", 3, 400), archived("b.gz", 2, 400)],
    );
    // 1200 > 1000: only the oldest has to go.
    expect(plan(l)).toEqual(["delete archive/a.gz"]);
    const big = listing(
      [],
      [archived("c.gz", 1, 900), archived("a.gz", 3, 300), archived("b.gz", 2, 300)],
    );
    expect(plan(big)).toEqual(["delete archive/a.gz", "delete archive/b.gz"]);
  });

  it("does not count age-expired files twice and keeps an archive within limits", () => {
    const l = listing([], [archived("old.gz", 40, 900), archived("new.gz", 1, 900)]);
    expect(plan(l)).toEqual(["delete archive/old.gz"]);
    expect(plan(listing([], [archived("new.gz", 1, 1000)]))).toEqual([]);
  });
});

describe("parseRunsListing", () => {
  const out = [
    "@@now",
    "1000000",
    "@@open",
    "/home/u/omi-runs/omi-056-minibox-20261111-090000.jsonl",
    "@@root",
    "omi-056-minibox-20261111-090000.jsonl|120|999000",
    "omi-056-current|0|999500",
    "weird name|1|2",
    "omi-bad|x|2",
    "@@archive",
    "omi-001-prompt.md.gz|50|900000",
  ].join("\n");

  it("reads files, marks open ones as live and skips unsafe or malformed lines", () => {
    expect(parseRunsListing(out)).toEqual({
      now: 1_000_000,
      root: [
        { name: "omi-056-minibox-20261111-090000.jsonl", size: 120, mtime: 999000, live: true },
        { name: "omi-056-current", size: 0, mtime: 999500, live: false },
      ],
      archive: [{ name: "omi-001-prompt.md.gz", size: 50, mtime: 900000, live: false }],
    });
  });

  it("copes with an absent runs directory but not with a missing clock", () => {
    expect(parseRunsListing("@@now\n5\n@@open\n@@root\n@@archive\n")).toEqual({
      now: 5,
      root: [],
      archive: [],
    });
    expect(() => parseRunsListing("")).toThrow(/timestamp/);
  });
});

describe("retentionScript", () => {
  it("is null with nothing to do and ignores keeps", () => {
    expect(retentionScript([])).toBeNull();
    expect(retentionScript([{ name: "omi-1-x.md", action: "keep", reason: "r" }])).toBeNull();
  });

  it("moves then gzips each archived file, then removes, guarded against vanished files", () => {
    const script = retentionScript([
      { name: "omi-052-prompt.md", action: "archive", reason: "r" },
      { name: "omi-052-current", action: "delete", reason: "r" },
      { name: "archive/old.gz", action: "delete", reason: "r" },
    ]);
    expect(script).toBe(
      "cd $HOME/omi-runs && mkdir -p archive && " +
        "for f in omi-052-prompt.md; do if [ -f $f ]; then mv -f $f archive/$f && gzip -f archive/$f; fi; done && " +
        "rm -f -- omi-052-current archive/old.gz",
    );
    expect(script).not.toMatch(/["\\\n]/);
  });
});
