import { describe, expect, it } from "vitest";
import {
  judgePromotion,
  selectPromotable,
  type PromotionCandidate,
} from "../../../../src/domain/tasks/promotion-policy.ts";

const BODY = "## Acceptance criteria\n- [ ] one\n\n<!-- omi-squad:plan-key=OMI-001 -->\n";

function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    number: 10,
    state: "OPEN",
    status: "Backlog",
    planKey: "OMI-001",
    body: BODY,
    priority: "P1",
    workType: "Task",
    workflow: "feature",
    role: "Developer",
    area: "tooling",
    milestone: "M1",
    blockers: [],
    blockersTruncated: false,
    ...overrides,
  };
}

describe("judgePromotion", () => {
  it("promotes a ready Backlog Issue whose blockers are all closed", () => {
    const blockers = [{ number: 3, state: "CLOSED" as const }];
    expect(judgePromotion(candidate({ blockers }))).toEqual({ kind: "promote" });
  });

  it("reports an Issue that is already Ready as done", () => {
    expect(judgePromotion(candidate({ status: "Ready" }))).toMatchObject({ kind: "done" });
  });

  it("refuses an Epic", () => {
    expect(judgePromotion(candidate({ workType: "Epic" }))).toEqual({
      kind: "refuse",
      reason: "#10 is an Epic",
    });
  });

  it.each(["In Progress", "Done", null])("refuses an Issue whose Status is %s", (status) => {
    expect(judgePromotion(candidate({ status }))).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("not Backlog") as unknown,
    });
  });

  it("refuses a closed Issue", () => {
    expect(judgePromotion(candidate({ state: "CLOSED" }))).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("closed") as unknown,
    });
  });

  it("refuses while any blocker is open and names it", () => {
    const blockers = [
      { number: 3, state: "CLOSED" as const },
      { number: 4, state: "OPEN" as const },
    ];
    expect(judgePromotion(candidate({ blockers }))).toEqual({
      kind: "refuse",
      reason: "#10: blocked by #4",
    });
  });

  it("refuses when more blockers exist than were read", () => {
    expect(judgePromotion(candidate({ blockersTruncated: true }))).toEqual({
      kind: "refuse",
      reason: "#10: more blockers than could be read",
    });
  });

  it("refuses an Issue that fails the readiness gate and lists every reason with the blocker", () => {
    const verdict = judgePromotion(
      candidate({ role: null, blockers: [{ number: 4, state: "OPEN" }] }),
    );
    expect(verdict).toEqual({ kind: "refuse", reason: "#10: blocked by #4; missing Role" });
  });
});

describe("selectPromotable", () => {
  it("picks the first eligible Backlog Issue by Priority, milestone, then number", () => {
    const picked = selectPromotable([
      candidate({ number: 30, priority: "P1", milestone: "M1" }),
      candidate({ number: 20, priority: "P0", milestone: "M2" }),
      candidate({ number: 21, priority: "P0", milestone: "M1" }),
      candidate({ number: 22, priority: "P0", milestone: "M1" }),
    ]);
    expect(picked.map((c) => c.number)).toEqual([21, 22, 20, 30]);
  });

  it("skips Issues that are blocked, not ready, not Backlog, closed or Epics", () => {
    const picked = selectPromotable([
      candidate({ number: 1, blockers: [{ number: 9, state: "OPEN" }] }),
      candidate({ number: 2, role: null }),
      candidate({ number: 3, status: "Ready" }),
      candidate({ number: 4, state: "CLOSED" }),
      candidate({ number: 5, workType: "Epic" }),
      candidate({ number: 6 }),
    ]);
    expect(picked.map((c) => c.number)).toEqual([6]);
  });

  it("ranks an Issue without a milestone after one with a milestone of the same Priority", () => {
    const picked = selectPromotable([
      candidate({ number: 2, priority: "P2", milestone: null }),
      candidate({ number: 3, priority: "P2", milestone: "M1" }),
    ]);
    expect(picked.map((c) => c.number)).toEqual([3, 2]);
  });

  it("never selects an Issue without a Priority because the gate refuses it", () => {
    expect(selectPromotable([candidate({ priority: null })])).toEqual([]);
  });

  it("returns an empty list when nothing is eligible", () => {
    expect(selectPromotable([candidate({ status: "Done" })])).toEqual([]);
  });
});
