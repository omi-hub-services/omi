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
