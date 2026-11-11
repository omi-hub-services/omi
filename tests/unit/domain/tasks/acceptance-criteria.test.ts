import { describe, expect, it } from "vitest";
import {
  acceptanceCriteria,
  tickAcceptanceCriteria,
} from "../../../../src/domain/tasks/acceptance-criteria.ts";

describe("tickAcceptanceCriteria", () => {
  it("ticks only top-level criteria in the AC section and keeps every other byte", () => {
    const body = [
      "## Goal",
      "- [ ] not a criterion",
      "## Acceptance criteria",
      "- [ ] first",
      "  - [ ] nested",
      "```",
      "- [ ] fenced",
      "```",
      "* [x] already ticked",
      "+ [ ] third",
      "### Notes",
      "- [ ] below subheading",
      "",
    ].join("\r\n");
    const ticked = tickAcceptanceCriteria(body);
    expect(ticked).toMatchObject({ total: 3, newly: 2 });
    expect(ticked.body).toBe(
      body.replace("- [ ] first", "- [x] first").replace("+ [ ] third", "+ [x] third"),
    );
    expect(acceptanceCriteria(ticked.body)).toEqual(acceptanceCriteria(body));
  });

  it("changes nothing when every criterion is already ticked or there are none", () => {
    const done = "## Acceptance criteria\n- [x] a\n- [X] b";
    expect(tickAcceptanceCriteria(done)).toEqual({ body: done, total: 2, newly: 0 });
    expect(tickAcceptanceCriteria("no section")).toEqual({
      body: "no section",
      total: 0,
      newly: 0,
    });
  });
});

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
