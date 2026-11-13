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
  area: "domain",
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

describe("Work Type workflow gate", () => {
  it.each(["Bug", "Docs", "Release", "Task", "Spike"])(
    "checks every workflow pairing for %s",
    (workType) => {
      for (const workflow of ["feature", "refactor", "bugfix", "docs", "release", "deploy"]) {
        const body = workType === "Bug" ? `${BODY}\n## Tái hiện\n1. Run failing command.` : BODY;
        const valid =
          workType === "Bug"
            ? workflow === "bugfix"
            : workType === "Docs"
              ? workflow === "docs"
              : workType === "Release"
                ? ["release", "deploy"].includes(workflow)
                : !["bugfix", "docs", "release", "deploy"].includes(workflow);
        expect(
          taskReadinessReasons({ ...ready, workType, workflow, body }),
          `${workType}/${workflow}`,
        ).toEqual(valid ? [] : [expect.stringContaining("Work Type")]);
      }
    },
  );
  it.each([
    "",
    "\n## Tái hiện\n   ",
    "\n## Tái hiện\n<!-- placeholder -->\n## Other\nEvidence elsewhere",
    "\n```md\n## Tái hiện\nexample\n```",
  ])("refuses Bug without reproduction evidence (%j)", (suffix) => {
    expect(
      taskReadinessReasons({ ...ready, workType: "Bug", workflow: "bugfix", body: BODY + suffix }),
    ).toContain("Bug requires non-empty ## Tái hiện");
  });
  it("refuses Task with a reproduction section and suggests Bug", () => {
    expect(taskReadinessReasons({ ...ready, body: `${BODY}\n## Tái hiện\n` })).toContain(
      "Task has ## Tái hiện; use Work Type Bug and Workflow bugfix",
    );
  });
  it("exempts Epic from pairing and reproduction rules", () => {
    expect(taskReadinessReasons({ ...ready, workType: "Epic", workflow: "bugfix" })).toEqual([]);
  });
});
