import { describe, expect, it } from "vitest";
import {
  issueSpecContent,
  nextPlanKey,
  parseIssueSpec,
  validateSpecOptions,
} from "../../../../tools/coordinator/issue-spec.ts";

const source = `---
title: A task
priority: P1
workType: Task
workflow: feature
role: Developer
area: tools
milestone: M1
epic: 1
blockedBy: []
---
## Mục tiêu
Do it.
## Phạm vi
One change.
## Acceptance criteria
- [ ] Works
## Dependencies
None.
`;

describe("Issue spec", () => {
  it("accepts required frontmatter and renders a marker and title", () => {
    const parsed = parseIssueSpec(source);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") throw new Error(parsed.reason);
    expect(issueSpecContent(parsed.spec, "OMI-060")).toMatchObject({
      title: "[OMI-060] A task",
      body: expect.stringContaining("<!-- omi-squad:plan-key=OMI-060 -->") as unknown,
    });
    const fields = Object.entries({
      Priority: "P1",
      "Work Type": "Task",
      Workflow: "feature",
      Role: "Developer",
      Area: "tools",
      Status: "Backlog",
    }).map(([name, value]) => ({ id: name, name, options: [{ id: value, name: value }] }));
    expect(validateSpecOptions(parsed.spec, fields)).toEqual([]);
    for (const field of fields) {
      expect(
        validateSpecOptions(
          parsed.spec,
          fields.filter((f) => f !== field),
        ),
      ).toEqual([expect.stringContaining(field.name)]);
    }
  });

  it.each([
    "title",
    "priority",
    "workType",
    "workflow",
    "role",
    "area",
    "milestone",
    "epic",
    "blockedBy",
  ])("requires %s", (field) => {
    expect(parseIssueSpec(source.replace(new RegExp(`^${field}:.*\\n`, "m"), "")).kind).toBe(
      "refuse",
    );
  });
  it.each(["Mục tiêu", "Phạm vi", "Acceptance criteria", "Dependencies"])(
    "requires section %s",
    (heading) => {
      expect(parseIssueSpec(source.replace(`## ${heading}`, "## Other")).kind).toBe("refuse");
    },
  );
  it.each([
    source.replace("- [ ] Works", "  - [ ] Nested"),
    source.replace("- [ ] Works", "```md\n- [ ] Example\n```"),
    source.replace("- [ ] Works", "### Detail\n- [ ] Nested"),
    source.replace("epic: 1", "epic: nope"),
    source.replace("blockedBy: []", "blockedBy: [0]"),
    source.replace("title: A task", "title: A task\ntitle: duplicate"),
    source.replace("workType: Task", "workType: Epic"),
    "bad input",
  ])("refuses invalid specs", (input) => {
    expect(parseIssueSpec(input).kind).toBe("refuse");
  });
  it("allocates above all keys, ignoring Epic keys and invalid keys", () => {
    expect(nextPlanKey([])).toBe("OMI-001");
    expect(nextPlanKey(["OMI-059", "EP-99", null, "OMI-003", "OMI-096"])).toBe("OMI-097");
    expect(() => nextPlanKey(["OMI-999"])).toThrow(/exhausted/);
  });
});
