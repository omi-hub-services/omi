import { expect, it } from "vitest";
import { validatePackedFiles } from "../../../tools/check-package.ts";

const files = [
  "dist/bootstrap/cli.js",
  "templates/project/project.yaml",
  "schemas/workflow.v1.schema.json",
  "migrations/0001-initial-state.sql",
].map((path) => ({ path }));

it("requires the shared prompt skeleton in the distributed package", () => {
  expect(() => {
    validatePackedFiles(files);
  }).toThrow(/worker-prompt/);
});

it("accepts the skeleton as a package asset outside installed project templates", () => {
  expect(() => {
    validatePackedFiles([...files, { path: "templates/prompts/worker-prompt.md" }]);
  }).not.toThrow();
});
