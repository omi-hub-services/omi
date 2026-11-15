import { describe, expect, it } from "vitest";
import { createIssueFromSpec } from "../../../../../src/application/use-cases/tasks/create-issue-from-spec.ts";
import { FRONTMATTER, FakeIntake, FakeSpecFile, SPEC_BODY, snapshot } from "./intake-fakes.ts";

const preview = { prefix: "OMI", apply: false };
const apply = { prefix: "OMI", apply: true };

function setup(frontmatter: Record<string, unknown> = FRONTMATTER, body = SPEC_BODY) {
  const spec = new FakeSpecFile({ kind: "ok", frontmatter, body });
  const intake = new FakeIntake();
  return { spec, intake, deps: { spec, intake } };
}

describe("createIssueFromSpec preview", () => {
  it("allocates the next key, shows the plan and writes nothing without --apply", async () => {
    const { deps, spec, intake } = setup();
    const result = await createIssueFromSpec(deps, preview);
    expect(result).toMatchObject({
      kind: "preview",
      plan: {
        planKey: "OMI-006",
        title: "[OMI-006] Validate a task",
        milestone: "M1",
        epic: 1,
        blockedBy: [2],
        fields: {
          Status: "Backlog",
          Priority: "P1",
          "Work Type": "Task",
          Workflow: "feature",
          Role: "Developer",
          Area: "tooling",
          "Plan Key": "OMI-006",
        },
      },
    });
    expect(result.kind === "preview" && result.plan.body).toContain(
      "<!-- omi-squad:plan-key=OMI-006 -->",
    );
    expect(intake.created).toEqual([]);
    expect(spec.recorded).toEqual([]);
  });

  it("counts closed Issues, title keys and Project-only keys when allocating", async () => {
    const { deps, intake } = setup();
    intake.data = snapshot({
      issues: [
        { number: 9, id: 109, title: "[OMI-020] old", body: "no marker" },
        ...snapshot().issues,
      ],
      projectPlanKeys: ["OMI-031", null],
    });
    const result = await createIssueFromSpec(deps, preview);
    expect(result).toMatchObject({ kind: "preview", plan: { planKey: "OMI-032" } });
  });

  it("does not let an Epic key consume a task number", async () => {
    const { deps, intake } = setup({ ...FRONTMATTER, blockedBy: [] });
    intake.data = snapshot({
      issues: [
        { number: 1, id: 101, title: "[EP-900] Epic", body: "<!-- omi-squad:plan-key=EP-900 -->" },
      ],
      projectPlanKeys: ["EP-900"],
    });
    expect(await createIssueFromSpec(deps, preview)).toMatchObject({
      plan: { planKey: "OMI-001" },
    });
  });

  it("does not repeat the title prefix when the spec title already has the key shape", async () => {
    const { deps } = setup({ ...FRONTMATTER, title: "[OMI-001] Validate a task" });
    expect(await createIssueFromSpec(deps, preview)).toMatchObject({
      plan: { title: "[OMI-006] Validate a task" },
    });
  });
});

describe("createIssueFromSpec --apply", () => {
  it("saves the marker before the remote write, then creates the Issue with resolved ids", async () => {
    const { deps, spec, intake } = setup();
    const order: string[] = [];
    const record = spec.recordPlanKeyMarker.bind(spec);
    spec.recordPlanKeyMarker = async (marker) => {
      order.push("marker");
      await record(marker);
    };
    const create = intake.createTask.bind(intake);
    intake.createTask = async (request) => {
      order.push("create");
      return create(request);
    };
    const result = await createIssueFromSpec(deps, apply);
    expect(result).toMatchObject({
      kind: "created",
      plan: { planKey: "OMI-006" },
      issueNumber: 50,
    });
    expect(order).toEqual(["marker", "create"]);
    expect(spec.recorded).toEqual(["<!-- omi-squad:plan-key=OMI-006 -->"]);
    expect(intake.created).toHaveLength(1);
    expect(intake.created[0]).toMatchObject({
      title: "[OMI-006] Validate a task",
      milestoneNumber: 7,
      projectId: "PVT_1",
      epic: { number: 1, id: 101 },
      blockedBy: [{ number: 2, id: 102 }],
      fields: [
        { fieldId: "F_priority", optionId: "P1" },
        { fieldId: "F_type", optionId: "T1" },
        { fieldId: "F_wf", optionId: "W1" },
        { fieldId: "F_role", optionId: "R1" },
        { fieldId: "F_area", optionId: "A1" },
        { fieldId: "F_status", optionId: "S1" },
        { fieldId: "F_key", text: "OMI-006" },
      ],
    });
  });

  it("keeps the marker when the remote write fails so a retry reuses the key", async () => {
    const { deps, spec, intake } = setup();
    intake.failCreate = true;
    await expect(createIssueFromSpec(deps, apply)).rejects.toThrow("remote failed");
    expect(spec.recorded).toEqual(["<!-- omi-squad:plan-key=OMI-006 -->"]);
  });

  it("prints done and creates nothing when the spec marker already exists on an Issue", async () => {
    const body = `${SPEC_BODY}\n\n<!-- omi-squad:plan-key=OMI-005 -->\n`;
    const { deps, spec, intake } = setup(FRONTMATTER, body);
    expect(await createIssueFromSpec(deps, apply)).toEqual({
      kind: "exists",
      planKey: "OMI-005",
      issueNumber: 2,
    });
    expect(intake.created).toEqual([]);
    expect(spec.recorded).toEqual([]);
  });

  it("reuses a saved marker that no Issue carries yet instead of allocating a new key", async () => {
    const body = `${SPEC_BODY}\n\n<!-- omi-squad:plan-key=OMI-040 -->\n`;
    const { deps, spec, intake } = setup(FRONTMATTER, body);
    expect(await createIssueFromSpec(deps, apply)).toMatchObject({
      kind: "created",
      plan: { planKey: "OMI-040" },
    });
    expect(spec.recorded).toEqual([]);
    expect(intake.created[0]?.body.match(/plan-key=/g)).toHaveLength(1);
  });

  it("refuses a saved marker that is already a Project Plan Key without a matching Issue", async () => {
    const body = `${SPEC_BODY}\n\n<!-- omi-squad:plan-key=OMI-031 -->\n`;
    const { deps, intake } = setup(FRONTMATTER, body);
    intake.data = snapshot({ projectPlanKeys: ["OMI-031"] });
    const result = await createIssueFromSpec(deps, apply);
    expect(result).toEqual({
      kind: "refused",
      reasons: ["OMI-031 is already allocated without a matching marker"],
    });
    expect(intake.created).toEqual([]);
  });
});

describe("createIssueFromSpec refusals (nothing is written)", () => {
  async function refusal(
    frontmatter: Record<string, unknown>,
    body = SPEC_BODY,
    data = snapshot(),
  ) {
    const { deps, spec, intake } = setup(frontmatter, body);
    intake.data = data;
    const result = await createIssueFromSpec(deps, apply);
    expect(intake.created).toEqual([]);
    expect(spec.recorded).toEqual([]);
    return result.kind === "refused" ? result.reasons.join(" | ") : `not refused: ${result.kind}`;
  }

  it("refuses an unreadable spec", async () => {
    const spec = new FakeSpecFile({ kind: "invalid", reason: "spec requires YAML frontmatter" });
    const result = await createIssueFromSpec({ spec, intake: new FakeIntake() }, apply);
    expect(result).toEqual({ kind: "refused", reasons: ["spec requires YAML frontmatter"] });
  });

  it("refuses a missing frontmatter key", async () => {
    const without = Object.fromEntries(
      Object.entries(FRONTMATTER).filter(([key]) => key !== "area"),
    );
    expect(await refusal(without)).toContain("area");
  });

  it("refuses an unknown frontmatter key", async () => {
    expect(await refusal({ ...FRONTMATTER, extra: 1 })).toContain("extra");
  });

  it("refuses a body without the required sections or a criterion", async () => {
    expect(await refusal(FRONTMATTER, "just text")).toContain("missing ## Acceptance criteria");
  });

  it("refuses an Epic spec", async () => {
    expect(await refusal({ ...FRONTMATTER, workType: "Epic" })).toContain("Epics");
  });

  it("refuses a value that is not a live Project option", async () => {
    expect(await refusal({ ...FRONTMATTER, priority: "P9" })).toContain(
      'Priority "P9" is not a Project option',
    );
  });

  it("refuses a Project without a Plan Key text field", async () => {
    const data = snapshot();
    expect(
      await refusal(FRONTMATTER, SPEC_BODY, {
        ...data,
        fields: data.fields.filter((f) => f.name !== "Plan Key"),
      }),
    ).toContain("Project needs a Plan Key text field");
  });

  it("refuses an unknown milestone", async () => {
    expect(await refusal({ ...FRONTMATTER, milestone: "M9" })).toContain('unknown milestone "M9"');
  });

  it("refuses an epic that is not an Epic", async () => {
    expect(await refusal({ ...FRONTMATTER, epic: 2 })).toContain(
      "Issue #2 is not an Epic with a Plan Key marker",
    );
  });

  it("refuses a missing Epic or blocker Issue", async () => {
    expect(await refusal({ ...FRONTMATTER, blockedBy: [77] })).toContain("Issue #77 not found");
  });

  it("lists several reasons together", async () => {
    const text = await refusal({ ...FRONTMATTER, priority: "P9", milestone: "M9" });
    expect(text).toContain('Priority "P9"');
    expect(text).toContain('unknown milestone "M9"');
  });
});
