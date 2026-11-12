import { describe, expect, it } from "vitest";
import {
  taskReadinessReasons,
  type TaskReadinessInput,
} from "../../../../src/domain/tasks/readiness-gate.ts";

const BODY = [
  "## Mục tiêu",
  "Do it.",
  "## Acceptance criteria",
  "- [ ] first",
  "## Dependencies",
  "None.",
  "<!-- omi-squad:plan-key=OMI-079 -->",
].join("\n");

const ready: TaskReadinessInput = {
  planKey: "OMI-079",
  body: BODY,
  priority: "P1",
  workType: "Task",
  workflow: "feature",
  role: "Developer",
  area: "tooling",
};

describe("taskReadinessReasons", () => {
  it("passes an Issue that has every field, a matching marker and one criterion", () => {
    expect(taskReadinessReasons(ready)).toEqual([]);
  });

  it.each([null, "", "   "])("refuses a missing Plan Key (%j)", (planKey) => {
    expect(taskReadinessReasons({ ...ready, planKey })).toContain("missing Plan Key");
  });

  it("refuses a Plan Key that is not PREFIX-NNN", () => {
    expect(taskReadinessReasons({ ...ready, planKey: "task-79" })).toContain(
      "Plan Key must look like PREFIX-NNN",
    );
  });

  it("refuses a body without a Plan Key marker", () => {
    const body = BODY.replace("<!-- omi-squad:plan-key=OMI-079 -->", "");
    expect(taskReadinessReasons({ ...ready, body })).toContain(
      "Plan Key must match exactly one body marker",
    );
  });

  it("refuses a marker that differs from the Project Plan Key", () => {
    const body = BODY.replace("OMI-079", "OMI-080");
    expect(taskReadinessReasons({ ...ready, body })).toContain(
      "Plan Key must match exactly one body marker",
    );
  });

  it("refuses two markers even when one matches", () => {
    const body = `${BODY}\n<!-- omi-squad:plan-key=OMI-080 -->`;
    expect(taskReadinessReasons({ ...ready, body })).toContain(
      "Plan Key must match exactly one body marker",
    );
  });

  it.each([
    ["priority", "Priority"],
    ["workType", "Work Type"],
    ["workflow", "Workflow"],
    ["role", "Role"],
    ["area", "Area"],
  ] as const)("refuses a missing %s field", (key, name) => {
    expect(taskReadinessReasons({ ...ready, [key]: null })).toEqual([`missing ${name}`]);
    expect(taskReadinessReasons({ ...ready, [key]: "  " })).toEqual([`missing ${name}`]);
  });

  it("refuses a body without an Acceptance criteria section", () => {
    const body = BODY.replace("## Acceptance criteria\n- [ ] first\n", "");
    expect(taskReadinessReasons({ ...ready, body })).toEqual([
      "Acceptance criteria needs at least one top-level checkbox",
    ]);
  });

  it("does not count a nested checkbox as an acceptance criterion", () => {
    const body = BODY.replace("- [ ] first", "- parent\n  - [ ] nested");
    expect(taskReadinessReasons({ ...ready, body })).toEqual([
      "Acceptance criteria needs at least one top-level checkbox",
    ]);
  });

  it("does not count a checkbox inside a code fence", () => {
    const body = BODY.replace("- [ ] first", "```\n- [ ] example\n```");
    expect(taskReadinessReasons({ ...ready, body })).toEqual([
      "Acceptance criteria needs at least one top-level checkbox",
    ]);
  });

  it("reports every failed condition at once", () => {
    expect(
      taskReadinessReasons({ ...ready, planKey: null, body: "", role: null, area: null }),
    ).toEqual([
      "missing Plan Key",
      "Plan Key must match exactly one body marker",
      "missing Role",
      "missing Area",
      "Acceptance criteria needs at least one top-level checkbox",
    ]);
  });
});
