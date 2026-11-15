import { expect, it } from "vitest";
import { mergeProjectTemplates } from "../../../../src/application/services/merge-project-templates.js";

it("merges unchanged CRLF local templates without conflicts", () => {
  expect(
    mergeProjectTemplates(
      { "workflows/docs.yaml": "name: docs\nversion: 1\n" },
      { "workflows/docs.yaml": "name: docs\nversion: 2\n" },
      { "workflows/docs.yaml": "name: docs\r\nversion: 1\r\n" },
    ),
  ).toEqual({
    merged: { "workflows/docs.yaml": "name: docs\nversion: 2\n" },
    conflicts: [],
    changes: ["workflows/docs.yaml"],
  });
});

it("reports divergent real edits in CRLF local templates as conflicts", () => {
  const local = { "rules/example.md": "local edit\r\n" };
  expect(
    mergeProjectTemplates(
      { "rules/example.md": "base\n" },
      { "rules/example.md": "incoming edit\n" },
      local,
    ),
  ).toEqual({ merged: local, conflicts: ["rules/example.md"], changes: [] });
});

it("preserves CRLF checkout bytes when template content is unchanged", () => {
  const local = { "rules/example.md": "same\r\n" };
  expect(
    mergeProjectTemplates(
      { "rules/example.md": "same\n" },
      { "rules/example.md": "same\n" },
      local,
    ),
  ).toEqual({ merged: local, conflicts: [], changes: [] });
});

it("writes changed and added templates as LF even when the package uses CRLF", () => {
  expect(
    mergeProjectTemplates(
      { "rules/example.md": "base\r\n" },
      { "rules/example.md": "changed\r\n", "rules/added.md": "added\r\n" },
      { "rules/example.md": "base\n" },
    ),
  ).toEqual({
    merged: { "rules/example.md": "changed\n", "rules/added.md": "added\n" },
    conflicts: [],
    changes: ["rules/added.md", "rules/example.md"],
  });
});

it("accepts matching concurrent edits despite different line endings", () => {
  const local = { "rules/example.md": "changed\r\n" };
  expect(
    mergeProjectTemplates(
      { "rules/example.md": "base\n" },
      { "rules/example.md": "changed\n" },
      local,
    ),
  ).toEqual({ merged: local, conflicts: [], changes: [] });
});

it("removes unchanged CRLF templates deleted by the package", () => {
  expect(
    mergeProjectTemplates({ "rules/example.md": "base\n" }, {}, { "rules/example.md": "base\r\n" }),
  ).toEqual({ merged: {}, conflicts: [], changes: ["rules/example.md"] });
});
