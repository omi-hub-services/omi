import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderWorkerPrompt } from "../../../src/application/services/render-worker-prompt.js";

it("keeps the shared prompt renderable outside installed project templates", () => {
  expect(existsSync("templates/project/.omi-squad/worker-prompt.md")).toBe(false);
  const skeleton = readFileSync("templates/prompts/worker-prompt.md", "utf8");
  expect(
    renderWorkerPrompt(skeleton, {
      identity: "identity",
      workspace: "workspace",
      read_first: "read first",
      task_context: "literal {{rules}}",
      notes: "notes",
      skills: "skills",
      rules: "rules",
      restrictions: "restrictions",
      report_contract: "report",
    }),
  ).toContain("literal {{rules}}");
});

it("keeps every documented Project Workflow option resolvable", async () => {
  const { readdirSync } = await import("node:fs");
  const { workflowOptionIssues } = await import("../../../src/domain/workflows/workflow-policy.ts");
  const field =
    readFileSync("docs/planning/github-project.md", "utf8")
      .split("\n")
      .find((line) => line.startsWith("| Workflow |")) ?? "";
  const options = (field.split("|")[3] ?? "").trim().split(", ");
  const templates = readdirSync("templates/project/workflows").map((f) => f.replace(/\.yaml$/, ""));
  expect(workflowOptionIssues(options, templates)).toEqual([]);
});
