import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { parse } from "yaml";
import { renderJsonSchemaFiles } from "../../../src/application/contracts/json-schema-catalog.ts";
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
});

// Virtual file trees keep deliberately forbidden names as data. Every materialized
// fixture runs the production CLI; the guard itself has no fixture exemptions.
const fixtureSchema = z.strictObject({
  guard: z.enum(["structure", "dependency", "schema", "naming"]),
  files: z.record(z.string(), z.string()),
  remove: z.array(z.string()).default([]),
  message: z.string(),
});
const cases = readdirSync(fixtures)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({
    name,
    ...fixtureSchema.parse(JSON.parse(readFileSync(join(fixtures, name), "utf8"))),
  }));

describe("isolated architecture violations", () => {
  it.each(cases)(
    "rejects $name with a clear diagnostic",
    ({ guard, files, remove, message }) => {
      const temporaryRoot = join(repo, ".tmp");
      mkdirSync(temporaryRoot, { recursive: true });
      const dir = mkdtempSync(join(temporaryRoot, "architecture-"));
      try {
        if (guard === "schema") {
          for (const file of renderJsonSchemaFiles())
            writeFileSync(join(dir, file.fileName), file.content);
        }
        for (const [file, content] of Object.entries(files)) {
          const target = join(dir, file);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
        for (const file of remove) rmSync(join(dir, file));
        let run;
        if (guard === "structure") {
          const init = spawnSync("git", ["init", "--quiet", dir], { encoding: "utf8" });
          expect(init.status, init.stderr).toBe(0);
          run = spawnSync(process.execPath, [join(repo, "tools/check-structure.ts"), dir], {
            encoding: "utf8",
          });
        } else if (guard === "dependency") {
          run = spawnSync(
            process.execPath,
            [
              depcruiseBin,
              "src",
              "--config",
              join(repo, ".dependency-cruiser.cjs"),
              "--output-type",
              "err",
            ],
            { cwd: dir, encoding: "utf8" },
          );
        } else if (guard === "schema") {
          run = spawnSync(
            process.execPath,
            [
              "--import",
              join(repo, "tools/register-ts-imports.ts"),
              join(repo, "tools/generate-schemas.ts"),
              "--check",
              dir,
            ],
            { cwd: repo, encoding: "utf8" },
          );
        } else {
          const entry = Object.entries(files)[0];
          if (entry === undefined) throw new Error("Naming fixture needs source text");
          run = spawnSync(
            process.execPath,
            [
              join(repo, "node_modules/eslint/bin/eslint.js"),
              "--stdin",
              "--stdin-filename",
              entry[0],
            ],
            { cwd: repo, encoding: "utf8", input: entry[1] },
          );
        }
        expect(run.error).toBeUndefined();
        if (guard === "dependency") expect(run.status, run.stdout + run.stderr).toBeGreaterThan(0);
        else expect(run.status, run.stdout + run.stderr).toBe(1);
        expect(run.stdout + run.stderr).toContain(message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("accepts the real repository through the production architecture and schema commands", () => {
    for (const script of ["check:architecture", "schemas:check"]) {
      const run = spawnSync("npm", ["run", script], { cwd: repo, encoding: "utf8" });
      expect(run.status, run.stdout + run.stderr).toBe(0);
    }
  }, 15_000);
});

describe("required check workflow contract", () => {
  it("always schedules check and issue-link for PRs to both protected branches", () => {
    const workflow = z
      .object({
        on: z.object({
          pull_request: z
            .object({ branches: z.array(z.string()), types: z.array(z.string()) })
            .strict(),
        }),
        jobs: z.object({
          check: z.object({
            steps: z.array(z.object({ run: z.string().optional() })),
            "continue-on-error": z.literal(false).optional(),
            if: z.never().optional(),
          }),
          "issue-link": z.object({
            if: z.literal("github.event_name == 'pull_request'"),
            "continue-on-error": z.literal(false).optional(),
          }),
        }),
      })
      .parse(parse(readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8")));
    expect(workflow.on.pull_request.branches).toEqual(["develop", "main"]);
    expect(workflow.on.pull_request.types).toEqual(
      expect.arrayContaining(["opened", "edited", "synchronize", "reopened"]),
    );
    expect(workflow.jobs.check.steps.some((step) => step.run === "npm run check")).toBe(true);
  });
});
