import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const fixtures = join(repo, "tests/fixtures/architecture");
// Same binary `npm run check:architecture` uses (package has no exported package.json).
const depcruiseBin = join(repo, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");

interface Violation {
  from: string;
  to: string;
  rule: { name: string };
}

const depcruise = (fixture: string, outputType: "json" | "err") =>
  spawnSync(
    process.execPath,
    [
      depcruiseBin,
      "src",
      "--config",
      join(repo, ".dependency-cruiser.cjs"),
      "--output-type",
      outputType,
    ],
    { cwd: join(fixtures, fixture), encoding: "utf8" },
  );

// JSON gives the details; the "err" reporter is what CI runs and sets the exit code.
function cruise(fixture: string): { status: number | null; violations: Violation[] } {
  const result = JSON.parse(depcruise(fixture, "json").stdout) as {
    summary: { violations: Violation[] };
  };
  return { status: depcruise(fixture, "err").status, violations: result.summary.violations };
}

function checkStructure(fixture: string) {
  return spawnSync(
    process.execPath,
    [join(repo, "tools/check-structure.ts"), join(fixtures, fixture)],
    {
      encoding: "utf8",
    },
  );
}

describe("dependency guard (.dependency-cruiser.cjs)", () => {
  it("accepts imports that follow the layer direction", () => {
    const { status, violations } = cruise("valid");
    expect(violations).toEqual([]);
    expect(status).toBe(0);
  });

  it("blocks wrong-direction imports, I/O in pure layers and cycles", () => {
    const { status, violations } = cruise("invalid-imports");
    const found = violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`);
    expect(found).toEqual(
      expect.arrayContaining([
        "domain-is-pure: src/domain/tasks/task.ts -> src/infrastructure/github/github-issues.ts",
        "domain-no-io-or-libraries: src/domain/tasks/task.ts -> fs",
        "application-only-ports: src/application/use-cases/tasks/import-task.ts -> src/infrastructure/github/github-issues.ts",
        "interfaces-not-to-infrastructure: src/interfaces/cli/commands/run-commands.ts -> src/infrastructure/github/github-issues.ts",
        "interfaces-no-sql-github-spawn: src/interfaces/cli/commands/run-commands.ts -> child_process",
        // OMI-011 AC-3: a command can reach neither SQLite adapters nor a SQL driver.
        "interfaces-not-to-infrastructure: src/interfaces/cli/commands/state-commands.ts -> src/infrastructure/persistence/sqlite/sqlite-state-store.ts",
        "interfaces-no-sql-github-spawn: src/interfaces/cli/commands/state-commands.ts -> ../../../../node_modules/better-sqlite3/lib/index.js",
      ]),
    );
    expect(violations.some((v) => v.rule.name === "no-circular")).toBe(true);
    expect(status).not.toBe(0);
  });
});

describe("structure guard (tools/check-structure.ts)", () => {
  it("accepts a tree that follows the folder map", () => {
    const run = checkStructure("valid");
    expect(run.stdout).toContain("check-structure: ok");
    expect(run.status).toBe(0);
  });

  it("reports misplaced root files, unknown dirs, bad names and misplaced tests", () => {
    const run = checkStructure("invalid-structure");
    expect(run.status).toBe(1);
    for (const expected of [
      "stray-script.js: root file not in the allowlist",
      'scripts/release.sh: root directory "scripts/" not in the allowlist',
      '"src/domain/utils/" is not a module directory',
      '"src/orchestration/" is not a module directory',
      "src/domain/tasks/TaskStatus.ts: source files must be kebab-case .ts",
      "src/domain/tasks/task-helpers.ts: vague name",
      "src/domain/tasks/task.test.ts: test files belong under",
    ]) {
      expect(run.stderr).toContain(expected);
    }
  });
});
