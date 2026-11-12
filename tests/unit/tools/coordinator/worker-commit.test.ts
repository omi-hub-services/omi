import { describe, expect, it } from "vitest";
import { judgeCommit, STAGE_PATHS } from "../../../../tools/coordinator/worker-commit.ts";

const BRANCH = "task/omi-077-script-first";

describe("STAGE_PATHS", () => {
  it("is exactly the allowed paths, never .tmp or .claude", () => {
    expect(STAGE_PATHS).toEqual(["src", "tests", "docs", "templates", "schemas"]);
  });
});

describe("judgeCommit", () => {
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
