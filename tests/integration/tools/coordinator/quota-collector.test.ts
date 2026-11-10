// Runs the quota collector (quota.ts REMOTE_COLLECTOR) with real Node against a temp $HOME, the
// way the WSL payload runs it: source on stdin, argv after `-`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_COLLECTOR } from "../../../../tools/coordinator/quota.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runCollector(home: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-", "omi-runs", "0"], {
    input: REMOTE_COLLECTOR,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  });
}

describe("quota collector", () => {
  it.skipIf(process.platform === "win32")(
    "skips a log that vanishes between readdir and stat instead of crashing",
    () => {
      const home = mkdtempSync(join(tmpdir(), "omi-quota-"));
      dirs.push(home);
      const runs = join(home, "omi-runs");
      mkdirSync(runs);
      const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed" } };
      writeFileSync(
        join(runs, "omi-052-ggtintran-20261110-120000.jsonl"),
        `${JSON.stringify(event)}\n`,
      );
      // A dangling symlink is listed by readdir but fails stat, like a log deleted in between.
      symlinkSync(join(runs, "gone.jsonl"), join(runs, "omi-051-minibox-20261110-110000.jsonl"));

      const result = runCollector(home);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const kinds = result.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { kind: string; file?: string });
      expect(kinds.map((k) => [k.kind, k.file])).toEqual([
        ["now", undefined],
        ["log", "omi-052-ggtintran-20261110-120000.jsonl"],
      ]);
    },
  );
});
