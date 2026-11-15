import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { regressionEvidenceCommand } from "../../../../tools/coordinator/regression-evidence.ts";
import { validRegressionEvidence } from "../../../../src/application/services/validate-review-evidence.ts";

import type { RegressionExecutor as Executor } from "../../../../src/application/ports/regression-runner.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
let dir: string;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-regression-"));
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...s: unknown[]) => void lines.push(s.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...s: unknown[]) => void lines.push(s.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const run = (baseExit: number | null, headExit: number | null, over = {}) => {
  const out = join(dir, "evidence.json");
  const execute = vi.fn<Executor>((where) =>
    Promise.resolve(
      where === "base"
        ? { revision: base, exitCode: baseExit }
        : { revision: head, exitCode: headExit },
    ),
  );
  return {
    out,
    execute,
    status: regressionEvidenceCommand({
      worktree: dir,
      testFile: "tests/unit/a.test.ts",
      testName: "fixes it",
      out,
      base,
      execute,
      ...over,
    }),
  };
};

it("writes red on the base and green on the head for review-comment to read", async () => {
  const r = run(1, 0);
  expect(await r.status).toBe(0);
  const evidence = JSON.parse(readFileSync(r.out, "utf8")) as unknown;
  expect(validRegressionEvidence(evidence, base, head)).toBe(true);
  expect(r.execute.mock.calls[0]?.[1]).toEqual([
    "npm",
    "run",
    "test:unit",
    "--",
    "tests/unit/a.test.ts",
    "-t",
    "fixes it",
  ]);
});

it.each([
  ["green on the base", 0, 0],
  ["red on the head", 1, 1],
])("refuses %s but still records what ran", async (_label, baseExit, headExit) => {
  const r = run(baseExit, headExit);
  expect(await r.status).toBe(1);
  expect(existsSync(r.out)).toBe(true);
  expect(lines.join("\n")).toContain("must fail on the base and pass on the head");
});

it("refuses a run without an exit status and writes no evidence", async () => {
  const r = run(null, 0);
  expect(await r.status).toBe(1);
  expect(existsSync(r.out)).toBe(false);
});

it.each(["src/a.test.ts", "../tests/unit/a.test.ts", "tests/other/a.test.ts"])(
  "refuses the test file %s",
  async (testFile) => {
    const r = run(1, 0, { testFile });
    expect(await r.status).toBe(1);
    expect(r.execute).not.toHaveBeenCalled();
  },
);
