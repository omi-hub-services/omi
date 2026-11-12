import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIssueSpecFile } from "../../../src/infrastructure/config/issue-spec-file.ts";

const SPEC = `---
title: Validate a task
priority: P1
epic: 1
blockedBy: []
---
## Mục tiêu
Goal.
## Acceptance criteria
- [ ] one
`;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-spec-"));
  file = join(dir, "spec.md");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createIssueSpecFile", () => {
  it("splits the YAML frontmatter from the Markdown body without validating the keys", async () => {
    writeFileSync(file, SPEC);
    expect(await createIssueSpecFile(file).read()).toEqual({
      kind: "ok",
      frontmatter: { title: "Validate a task", priority: "P1", epic: 1, blockedBy: [] },
      body: "## Mục tiêu\nGoal.\n## Acceptance criteria\n- [ ] one\n",
    });
  });

  it("reads a spec with Windows line endings", async () => {
    writeFileSync(file, SPEC.replace(/\n/g, "\r\n"));
    expect(await createIssueSpecFile(file).read()).toMatchObject({
      kind: "ok",
      frontmatter: { title: "Validate a task" },
    });
  });

  it("refuses a spec without frontmatter", async () => {
    writeFileSync(file, "## Mục tiêu\nGoal.\n");
    expect(await createIssueSpecFile(file).read()).toEqual({
      kind: "invalid",
      reason: "spec requires YAML frontmatter",
    });
  });

  it("refuses invalid YAML and duplicate keys without echoing the file", async () => {
    writeFileSync(file, "---\ntitle: a\ntitle: b\n---\nbody\n");
    expect(await createIssueSpecFile(file).read()).toEqual({
      kind: "invalid",
      reason: "frontmatter is not valid YAML",
    });
  });

  it("refuses a file that is missing", async () => {
    expect(await createIssueSpecFile(join(dir, "nope.md")).read()).toEqual({
      kind: "invalid",
      reason: "spec file cannot be read",
    });
  });

  it("appends the Plan Key marker once, keeping the file otherwise as it was", async () => {
    writeFileSync(file, SPEC);
    const spec = createIssueSpecFile(file);
    await spec.recordPlanKeyMarker("<!-- omi-squad:plan-key=OMI-006 -->");
    expect(readFileSync(file, "utf8")).toBe(`${SPEC}\n<!-- omi-squad:plan-key=OMI-006 -->\n`);
    expect(await spec.read()).toMatchObject({
      kind: "ok",
      body: expect.stringContaining("plan-key=OMI-006") as unknown,
    });
  });
});
