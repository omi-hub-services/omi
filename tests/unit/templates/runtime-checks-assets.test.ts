import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { workerPromptAssets } from "../../../src/application/services/worker-prompt-assets.js";
import { workflowSchema } from "../../../src/application/contracts/workflow.js";

it.each(["feature", "bugfix", "refactor"])(
  "makes the runtime run project-check right after implement in %s",
  (id) => {
    const workflow = workflowSchema.parse(
      parse(readFileSync(`templates/project/workflows/${id}.yaml`, "utf8")),
    );
    const step = workflow.steps.find((entry) => entry.id === "implement");
    expect(step?.required_checks).toContain("project-check");
  },
);

it("tells a shell-less developer the runtime runs the checks and that this is not a blocker", () => {
  const text = workerPromptAssets.developerChecks;
  expect(text).toContain("runtime runs the required checks");
  expect(text).toContain("not a reason to report blocked");
  expect(text).toContain("unverified");
});
