import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../../../tools/coordinator/issue-creation.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const source = `---
title: A task
priority: P1
workType: Task
workflow: feature
role: Developer
area: tools
milestone: M1
epic: 1
blockedBy: [2]
---
## Mục tiêu
Do it.
## Phạm vi
One change.
## Acceptance criteria
- [ ] Works
## Implementation map
- src/application/map.ts
## Dependencies
- #2
`;

describe("new-issue with fake GitHub", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omi-issue-"));
    file = join(dir, "spec.md");
    writeFileSync(file, source);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function fake(options: { invalidOption?: boolean; existing?: boolean } = {}) {
    const seen: Command[] = [];
    const fields = Object.entries({
      Priority: "P1",
      "Work Type": "Task",
      Workflow: "feature",
      Role: "Developer",
      Area: "tools",
      Status: "Backlog",
    }).map(([name, value]) => ({
      id: name,
      name,
      options: [
        { id: `opt-${value}`, name: options.invalidOption && name === "Role" ? "Other" : value },
      ],
    }));
    let createdBody: string | undefined;
    const run: Runner = (command) => {
      seen.push(command);
      const query = command.input
        ? (JSON.parse(command.input) as { query?: string }).query
        : undefined;
      const path = command.args[1] ?? "";
      let result: unknown = {};
      if (query?.includes("addProjectV2ItemById"))
        result = { data: { addProjectV2ItemById: { item: { id: "ITEM" } } } };
      else if (query?.includes("fields(first"))
        result = {
          data: {
            organization: {
              projectV2: {
                id: "PROJECT",
                fields: {
                  nodes: [...fields, { id: "KEY", name: "Plan Key", dataType: "TEXT" }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        };
      else if (query) {
        const variables = JSON.parse(command.input ?? "{}") as {
          variables: { after: string | null };
        };
        result = {
          data: {
            organization: {
              projectV2: {
                items: {
                  nodes: [{ planKey: { text: variables.variables.after ? "OMI-062" : "OMI-060" } }],
                  pageInfo: { hasNextPage: !variables.variables.after, endCursor: "NEXT" },
                },
              },
            },
          },
        };
      } else if (path.includes("issues?"))
        result = [
          [
            {
              number: 1,
              id: 101,
              title: "[EP-01] Epic",
              body: "<!-- omi-squad:plan-key=EP-01 -->",
            },
            { number: 2, id: 102, title: "Dependency", body: "" },
          ],
          [
            {
              number: 90,
              id: 190,
              state: "CLOSED",
              title: "[OMI-061] Closed task",
              body: "<!-- omi-squad:plan-key=OMI-061 -->",
            },
            ...(options.existing || createdBody
              ? [
                  {
                    number: 99,
                    id: 199,
                    title: "[OMI-063] A task",
                    body: createdBody ?? "<!-- omi-squad:plan-key=OMI-063 -->",
                  },
                ]
              : []),
          ],
        ];
      else if (path.includes("milestones?")) result = [[{ number: 5, title: "M1" }]];
      else if (path.endsWith("/issues") && command.args.includes("POST")) {
        createdBody = (JSON.parse(command.input ?? "{}") as { body: string }).body;
        result = { number: 99, id: 199, node_id: "ISSUE" };
      }
      return Promise.resolve({ code: 0, stdout: JSON.stringify(result), stderr: "" });
    };
    return { run, seen };
  }

  it("dry-run allocates above closed and paginated Project keys without any writes", async () => {
    const { run, seen } = fake();
    expect(await createIssue(run, file, true)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(source);
    expect(
      seen.every(
        (c) =>
          !c.args.includes("POST") &&
          !c.args.includes("item-edit") &&
          !c.input?.includes("mutation"),
      ),
    ).toBe(true);
    expect(vi.mocked(console.log).mock.calls.flat().join()).toContain("[OMI-063] A task");
  });
  it("creates marker, milestone, all fields, parent and dependencies, and re-runs without duplicates", async () => {
    const { run, seen } = fake();
    expect(await createIssue(run, file, false)).toBe(0);
    const create = seen.find((c) => c.args[1]?.endsWith("/issues") && c.args.includes("POST"));
    expect(JSON.parse(create?.input ?? "{}")).toMatchObject({
      title: "[OMI-063] A task",
      milestone: 5,
      body: expect.stringContaining("plan-key=OMI-063") as unknown,
    });
    expect(readFileSync(file, "utf8")).toContain("plan-key=OMI-063");
    const edits = seen.filter((c) => c.args.includes("item-edit"));
    expect(edits).toHaveLength(7);
    for (const option of ["P1", "Task", "feature", "Developer", "tools", "Backlog"])
      expect(edits.some((c) => c.args.includes(`opt-${option}`))).toBe(true);
    expect(edits.some((c) => c.args.includes("--text") && c.args.includes("OMI-063"))).toBe(true);
    expect(seen.find((c) => c.args[1]?.endsWith("/sub_issues"))?.input).toBe(
      '{"sub_issue_id":199}',
    );
    expect(seen.find((c) => c.args[1]?.endsWith("/blocked_by"))?.input).toBe('{"issue_id":102}');
    seen.length = 0;
    expect(await createIssue(run, file, false)).toBe(0);
    expect(
      seen.every(
        (c) =>
          !c.args.includes("POST") &&
          !c.args.includes("item-edit") &&
          !c.input?.includes("mutation"),
      ),
    ).toBe(true);
    expect(vi.mocked(console.log).mock.calls.flat().join()).toContain("done:");
  });
  it("validates local input before contacting GitHub", async () => {
    writeFileSync(file, source.replace("role: Developer\n", ""));
    const { run, seen } = fake();
    expect(await createIssue(run, file, false)).toBe(1);
    expect(seen).toEqual([]);
  });
  it("refuses live invalid options before writing anything", async () => {
    const { run, seen } = fake({ invalidOption: true });
    expect(await createIssue(run, file, false)).toBe(1);
    expect(seen).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(source);
    expect(vi.mocked(console.error).mock.calls.flat().join()).toContain(
      'Role "Developer" is not a Project option',
    );
  });
});
