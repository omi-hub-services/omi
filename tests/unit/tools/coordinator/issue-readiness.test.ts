import { describe, expect, it } from "vitest";
import {
  issueReadinessReasons,
  ISSUE_FIELDS,
  type IssueReadiness,
} from "../../../../tools/coordinator/issue-readiness.ts";
import {
  issueReadinessWarnings,
  type ProjectItem,
} from "../../../../tools/coordinator/github-snapshot.ts";
import { planSetStatus } from "../../../../tools/coordinator/flow-plans.ts";

const ready: IssueReadiness = {
  planKey: "OMI-059",
  body: "## Acceptance criteria\n- [ ] Works\n\n<!-- omi-squad:plan-key=OMI-059 -->",
  priority: "P1",
  workType: "Task",
  workflow: "feature",
  role: "Developer",
  area: "tools",
};
describe("Issue readiness", () => {
  it("accepts complete data", () => {
    expect(issueReadinessReasons(ready)).toEqual([]);
  });
  it("requires a matching marker and Plan Key", () => {
    expect(issueReadinessReasons({ ...ready, planKey: null })).toContain("missing Plan Key");
    expect(issueReadinessReasons({ ...ready, planKey: "OMI-060" }).join()).toMatch(/match/);
    expect(
      issueReadinessReasons({
        ...ready,
        body: ready.body + "\n<!-- omi-squad:plan-key=OMI-059 -->",
      }).join(),
    ).toMatch(/exactly one/);
  });
  it.each(Object.entries(ISSUE_FIELDS))("requires %s", (key, name) => {
    expect(issueReadinessReasons({ ...ready, [key]: " " })).toContain(`missing ${name}`);
  });
  it("requires top-level AC", () => {
    expect(
      issueReadinessReasons({ ...ready, body: ready.body.replace("- [ ]", "  - [ ]") }).join(),
    ).toMatch(/top-level/);
  });
  it.each(["Ready", "In Progress"])("gates %s even when already set", (status) => {
    const field = { projectId: "P", fieldId: "F", options: [{ id: "O", name: status }] };
    const item = { itemId: "I", status };
    expect(planSetStatus(96, status, field, item, { ...ready, role: null })).toEqual({
      kind: "refuse",
      reason: "#96: missing Role",
    });
    expect(planSetStatus(96, status, field, item, ready).kind).toBe("done");
  });
  it("reports legacy active/Done items without throwing, excluding closed Issues and Epics", () => {
    const item: ProjectItem = {
      ...ready,
      role: null,
      kind: "Issue",
      number: 96,
      title: "Task",
      state: "OPEN",
      status: "In Progress",
      milestone: null,
      blockers: [],
      blockersTruncated: false,
    };
    expect(
      issueReadinessWarnings([
        item,
        { ...item, number: 97, status: "Done" },
        { ...item, state: "CLOSED" },
        { ...item, workType: "Epic" },
        { ...item, kind: "PullRequest" },
      ]),
    ).toEqual(["#96: missing Role", "#97: missing Role"]);
  });
});
