import { describe, expect, it } from "vitest";
import { issueSpecBodyReasons } from "../../../../src/domain/tasks/issue-spec-policy.ts";

const BODY = [
  "## Mục tiêu",
  "Goal.",
  "## Phạm vi",
  "Scope.",
  "## Acceptance criteria",
  "- [ ] one",
  "## Implementation map",
  "- `src/application/map.ts`",
  "## Dependencies",
  "None.",
].join("\n");

const reasons = (body: string, workType = "Task") => issueSpecBodyReasons(body, workType, "OMI");

describe("issueSpecBodyReasons", () => {
  it("accepts a body with the four sections and one criterion", () => {
    expect(reasons(BODY)).toEqual([]);
  });

  it.each(["Mục tiêu", "Phạm vi", "Acceptance criteria", "Dependencies"])(
    "refuses a body without ## %s",
    (heading) => {
      const body = BODY.replace(`## ${heading}`, `### ${heading}`);
      expect(reasons(body)).toContain(`missing ## ${heading}`);
    },
  );

  it.each([
    ["missing", BODY.replace("## Implementation map\n- `src/application/map.ts`\n", "")],
    ["without a valid path", BODY.replace("`src/application/map.ts`", "../escape.ts")],
  ])("refuses a spec whose Implementation map is %s", (_name, body) => {
    expect(reasons(body)).toEqual(["Implementation map needs at least one valid relative path"]);
  });

  it("does not take a heading inside a code fence as a section", () => {
    const body = BODY.replace("## Dependencies\nNone.", "```\n## Dependencies\n```");
    expect(reasons(body)).toContain("missing ## Dependencies");
  });

  it("refuses an Acceptance criteria section without a top-level checkbox", () => {
    expect(reasons(BODY.replace("- [ ] one", "- plain"))).toContain(
      "Acceptance criteria needs at least one top-level checkbox",
    );
  });

  it("refuses to create an Epic", () => {
    expect(reasons(BODY, "Epic")).toContain("creating Epics is outside this command's scope");
  });

  it("accepts one marker of the project prefix", () => {
    expect(reasons(`${BODY}\n<!-- omi-squad:plan-key=OMI-007 -->`)).toEqual([]);
  });

  it("refuses two markers and a marker of another prefix", () => {
    const two = `${BODY}\n<!-- omi-squad:plan-key=OMI-007 -->\n<!-- omi-squad:plan-key=OMI-008 -->`;
    expect(reasons(two)).toContain("spec may have at most one OMI-NNN marker");
    expect(reasons(`${BODY}\n<!-- omi-squad:plan-key=EP-001 -->`)).toContain(
      "spec may have at most one OMI-NNN marker",
    );
  });

  it("refuses a malformed marker", () => {
    expect(reasons(`${BODY}\n<!-- omi-squad:plan-key=oops -->`)).toContain(
      "malformed Plan Key marker",
    );
  });
});
