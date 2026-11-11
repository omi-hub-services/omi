import { describe, expect, it } from "vitest";
import type { ProjectItem } from "../../../../tools/coordinator/github-snapshot.ts";
import {
  judgePromotion,
  promotableBacklog,
  type PromoteInput,
} from "../../../../tools/coordinator/promote.ts";

const body = (key: string) =>
  `## Acceptance criteria\n- [ ] one\n<!-- omi-squad:plan-key=${key} -->`;

function input(over: Partial<PromoteInput> = {}): PromoteInput {
  return {
    status: "Backlog",
    planKey: "OMI-070",
    body: body("OMI-070"),
    priority: "P1",
    workType: "Task",
    workflow: "feature",
    role: "Developer",
    area: "tooling",
    blockers: [],
    blockersTruncated: false,
    ...over,
  };
}

function item(over: Partial<ProjectItem> & { number: number }): ProjectItem {
  const key = `OMI-${String(over.number).padStart(3, "0")}`;
  return {
    kind: "Issue",
    title: `[${key}] task`,
    state: "OPEN",
    status: "Backlog",
    priority: "P1",
    workType: "Task",
    planKey: key,
    body: body(key),
    workflow: "feature",
    role: "Developer",
    area: "tooling",
    milestone: "M1 — Core foundation",
    blockers: [],
    blockersTruncated: false,
    ...over,
  };
}

describe("judgePromotion", () => {
  it("promotes a Backlog Issue whose blockers are all closed and that passes the gate", () => {
    expect(judgePromotion(70, input({ blockers: [{ number: 9, state: "CLOSED" }] }))).toEqual({
      kind: "promote",
    });
  });

  it("reports an Issue that is already Ready as done", () => {
    expect(judgePromotion(70, input({ status: "Ready" }))).toMatchObject({ kind: "done" });
  });

  it.each([
    ["an open blocker", { blockers: [{ number: 8, state: "OPEN" }] }, /blocked by #8/],
    ["unreadable blockers", { blockersTruncated: true }, /more blockers/],
    ["an Epic", { workType: "Epic" }, /#70 is an Epic/],
    ["In Progress", { status: "In Progress" }, /In Progress, not Backlog/],
    ["no Status", { status: null }, /\(none\), not Backlog/],
    ["a failing readiness gate", { role: null }, /missing Role/],
  ] as const)("refuses %s", (_name, over, reason) => {
    const verdict = judgePromotion(70, input(over));
    expect(verdict.kind).toBe("refuse");
    expect(verdict).toMatchObject({ reason: expect.stringMatching(reason) as unknown });
  });

  it("an Epic is refused even when it is Ready", () => {
    expect(judgePromotion(70, input({ workType: "Epic", status: "Ready" })).kind).toBe("refuse");
  });
});

describe("promotableBacklog", () => {
  it("orders like status.ts and skips blocked, Epic, non-Backlog and gate-failing Issues", () => {
    const picked = promotableBacklog([
      item({ number: 7, priority: "P2" }),
      item({ number: 6, priority: "P1", milestone: "M2 — Execution" }),
      item({ number: 5, priority: "P1", blockers: [{ number: 1, state: "OPEN" }] }),
      item({ number: 4, priority: "P0", workType: "Epic" }),
      item({ number: 3, priority: "P0", status: "Ready" }),
      item({ number: 2, priority: "P0", role: null }),
      item({ number: 9, priority: "P1", blockers: [{ number: 1, state: "CLOSED" }] }),
    ]);
    expect(picked.map((r) => r.item.number)).toEqual([9, 6, 7]);
  });

  it("is empty when nothing qualifies", () => {
    expect(promotableBacklog([item({ number: 5, status: "Ready" })])).toEqual([]);
  });
});
