import { describe, expect, it, vi } from "vitest";
import { commitWorkerCommand } from "../../../../tools/coordinator/flow-workers.ts";
import type { Runner } from "../../../../tools/coordinator/process-runner.ts";
import { judgeCommit, STAGE_PATHS } from "../../../../tools/coordinator/worker-commit.ts";

const BRANCH = "task/omi-077-script-first";

describe("STAGE_PATHS", () => {
  it.each(["CHANGELOG.md", "README.md"])("stages the committable root file %s", (path) => {
    expect(STAGE_PATHS).toContain(path);
  });

  it("is exactly the allowed paths, never .tmp or .claude", () => {
    expect(STAGE_PATHS).toEqual([
      "src",
      "tests",
      "docs",
      "templates",
      "schemas",
      "tools",
      "AGENTS.md",
      "CHANGELOG.md",
      "README.md",
      "package.json",
      "package-lock.json",
    ]);
  });
});

describe("judgeCommit", () => {
  it.each(["CHANGELOG.md", "README.md"])("accepts the staged root file %s", (path) => {
    expect(judgeCommit(BRANCH, BRANCH, [path, "docs/operations/handbook.md"])).toEqual({
      kind: "commit",
    });
  });

  it("commits when on the branch with allowed paths staged", () => {
    expect(judgeCommit(BRANCH, BRANCH, ["src/a.ts", "docs/x.md", "templates/p/r.md"])).toEqual({
      kind: "commit",
    });
  });

  it("refuses the wrong branch", () => {
    const r = judgeCommit(BRANCH, "develop", ["src/a.ts"]);
    expect(r).toMatchObject({ kind: "refuse" });
    expect(r.kind === "refuse" && r.reason).toMatch(/develop.*task\/omi-077/);
  });

  it("refuses when nothing is staged", () => {
    const r = judgeCommit(BRANCH, BRANCH, []);
    expect(r.kind === "refuse" && r.reason).toMatch(/nothing/);
  });

  it("refuses when the index already holds a path outside the allowed ones", () => {
    const r = judgeCommit(BRANCH, BRANCH, ["src/a.ts", ".claude/skills/x/SKILL.md", ".tmp/n.txt"]);
    expect(r.kind === "refuse" && r.reason).toContain(".claude/skills/x/SKILL.md");
    expect(r.kind === "refuse" && r.reason).toContain(".tmp/n.txt");
  });

  it("does not treat a lookalike directory as allowed", () => {
    expect(judgeCommit(BRANCH, BRANCH, ["srcx/a.ts"]).kind).toBe("refuse");
    expect(judgeCommit(BRANCH, BRANCH, ["src"]).kind).toBe("refuse");
  });
});

describe("commitWorkerCommand leftovers", () => {
  it.each(["tracked", "untracked"])(
    "refuses and names an unstaged %s path outside the stage list",
    async (kind) => {
      const path = "outside-scope.txt";
      let committed = false;
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Model Git's pathspec filtering: a scoped query cannot see this root file.
      const run: Runner = (command) => {
        const payload = command.args.at(-1) ?? "";
        let stdout = "";
        if (payload.includes("rev-parse --abbrev-ref HEAD")) stdout = BRANCH;
        else if (payload.includes("diff --cached --name-only"))
          stdout = "docs/operations/handbook.md\n";
        else if (
          (kind === "tracked" && payload.includes("diff --name-only")) ||
          (kind === "untracked" && payload.includes("ls-files --others --exclude-standard")) ||
          payload.includes("status --porcelain")
        ) {
          if (!payload.includes(" -- ") || payload.includes(` -- ${path}`)) stdout = `${path}\n`;
        } else if (
          payload.includes("diff --name-only") ||
          payload.includes("ls-files --others --exclude-standard")
        )
          stdout = "";
        else if (payload.includes("commit -F -")) committed = true;
        else if (payload.includes("rev-parse HEAD")) stdout = "a".repeat(40);
        else if (!payload.includes("add -A --")) throw new Error(`Unexpected command: ${payload}`);
        return Promise.resolve({ code: 0, stdout, stderr: "" });
      };
      try {
        const result = await commitWorkerCommand(
          { run, target: { repoDir: "/unused", distro: "unused", viaWslExe: false } },
          { branch: BRANCH, message: "Reproduction (OMI-145)", dryRun: false },
        );
        expect.soft(result).toBe(1);
        expect.soft(committed).toBe(false);
        expect(errors.mock.calls.flat().join("\n")).toContain(path);
      } finally {
        errors.mockRestore();
        output.mockRestore();
      }
    },
  );
});
