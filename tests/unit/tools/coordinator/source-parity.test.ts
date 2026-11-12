import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each(["omi-next", "omi-status", "omi-watch"])(
  "packages the repository %s skill as a template",
  (name) => {
    const path = `templates/bridges/repository/${name}/SKILL.md`;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("node tools/coordinator/");
  },
);

it("owns worker restrictions and report text in packaged prompt templates", () => {
  for (const name of [
    "repository-read-first",
    "repository-worker-restrictions",
    "repository-worker-report",
  ]) {
    expect(existsSync(`templates/prompts/${name}.md`)).toBe(true);
  }
  expect(readFileSync("tools/coordinator/flow-prompt.ts", "utf8")).not.toContain(
    "const RESTRICTIONS = `",
  );
});

it("keeps runtime worker instructions in templates too", () => {
  const source = readFileSync("src/application/use-cases/runs/dispatch-step.ts", "utf8");
  expect(source).not.toContain('"Do not push, open PRs, merge, or change GitHub state."');
  expect(existsSync("templates/prompts/runtime-worker-report.md")).toBe(true);
});

it("keeps shared quality instructions in packaged templates", () => {
  expect(
    readFileSync("src/application/services/render-worker-prompt.ts", "utf8").includes(
      "QA judges the supplied script-run check evidence; do not rerun tests.",
    ),
  ).toBe(false);
});
