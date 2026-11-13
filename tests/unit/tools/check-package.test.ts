import { expect, it } from "vitest";
import { validatePackedFiles } from "../../../tools/check-package.ts";

const files = [
  "CHANGELOG.md",
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

it("ships the changelog required by version-based updates", () => {
  expect(() => {
    validatePackedFiles([
      ...files,
      { path: "templates/prompts/worker-prompt.md" },
      { path: "CHANGELOG.md" },
    ]);
  }).not.toThrow();
});
it("refuses an archive without the changelog needed by version-based updates", () => {
  expect(() => {
    validatePackedFiles([
      ...files.filter((file) => file.path !== "CHANGELOG.md"),
      { path: "templates/prompts/worker-prompt.md" },
    ]);
  }).toThrow(/changelog/i);
});
