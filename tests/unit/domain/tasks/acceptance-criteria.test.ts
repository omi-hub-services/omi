import { describe, expect, it } from "vitest";
import { acceptanceCriteria } from "../../../../src/domain/tasks/acceptance-criteria.ts";

describe("acceptance criteria", () => {
  it("preserves order and excludes nested/fenced checkboxes and later subheadings", () => {
    expect(
      acceptanceCriteria(
        [
          "- [ ] outside",
          "## Acceptance criteria",
          "- [ ] first",
          "  - [ ] nested",
          "```md",
          "- [ ] fenced",
          "## Wrong heading inside fence",
          "````",
          "- [X] second",
          "~~~",
          "- [ ] also fenced",
          "~~~",
          "### Details",
          "- [ ] below subheading",
          "## Other",
          "- [ ] outside",
        ].join("\r\n"),
      ),
    ).toEqual(["first", "second"]);
  });
  it.each(["", "## Acceptance criteria\n", "```\n## Acceptance criteria\n- [ ] example\n```"])(
    "returns zero for missing or empty section",
    (body) => {
      expect(acceptanceCriteria(body)).toEqual([]);
    },
  );
});
