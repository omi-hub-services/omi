import { describe, expect, it } from "vitest";
import { COORDINATOR_LOGIN } from "../../../../tools/coordinator/coordinator-settings.ts";
import type { CarryJudgement } from "../../../../tools/coordinator/carried-pass.ts";
import {
  planClose,
  planMerge,
  type Plan,
  type PullForMerge,
  type ReferencingPull,
  type StatusField,
} from "../../../../tools/coordinator/flow-plans.ts";

// merge and close take a carried PASS only when git confirmed a clean sync (OMI-069).
const OLD = "a0b1c2d3e4f5a6b7c8d9a0b1c2d3e4f5a6b7c8d9";
const NEW = "b0ab3b3b1aa20def858c14f954303c6cc63178bc";
const by = (body: string) => ({ author: COORDINATOR_LOGIN, body });
const plain = (head: string, extra = "") =>
  by(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\`\n${extra}`);
const carried = (head: string, from: string, extra = "") =>
  by(
    `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\` · **CARRIED_FROM:** \`${from}\`\n${extra}`,
  );

const ok: CarryJudgement = { ok: true, developCommit: "d".repeat(40) };
const bad: CarryJudgement = {
  ok: false,
  reason: "tree of b0ab3b3 differs from the automatic merge",
};

describe("planMerge with a carried PASS", () => {
  const pull: PullForMerge = {
    number: 62,
    title: "OMI-050",
    state: "OPEN",
    isDraft: false,
    headRefName: "task/omi-050-x",
    baseRefName: "develop",
    headRefOid: NEW,
    body: "Issue: #61",
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeCommit: null,
    comments: [plain(OLD), carried(NEW, OLD)],
    checks: [{ name: "check", state: "pass" }],
  };
  const merge = (carry?: CarryJudgement) => planMerge(pull, "b0ab3b3", ["check"], carry);

  it("merges when git confirms the clean sync", () => {
    expect(merge(ok).kind).toBe("run");
  });

  it("refuses as a wrong-head PASS when the head is hand-edited", () => {
    expect(merge(bad)).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(
        /PR #62 wrong-head PASS: PASS @b0ab3b3 carried from a0b1c2d .*differs from the automatic merge/,
      ) as unknown,
    });
  });

  it("refuses when nobody verified the carry (fail closed)", () => {
    expect(merge(undefined)).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(/wrong-head PASS.*not verified/) as unknown,
    });
  });

  it("does not need a judgement for an ordinary PASS", () => {
    const ordinary = { ...pull, comments: [plain(NEW)] };
    expect(planMerge(ordinary, "b0ab3b3", ["check"]).kind).toBe("run");
  });

  it("ignores a carried PASS posted by another account", () => {
    const forged = { ...pull, comments: [{ ...carried(NEW, OLD), author: "someone-else" }] };
    expect(planMerge(forged, "b0ab3b3", ["check"], ok)).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(/none found; ignored VERDICT from someone-else/) as unknown,
    });
  });
});

describe("planClose with a carried PASS", () => {
  const field: StatusField = {
    projectId: "P",
    fieldId: "F",
    options: [{ id: "done", name: "Done" }],
  };
  const body = "## Acceptance criteria\n- [ ] one\n- [ ] two\n";
  const issue = { number: 61, state: "OPEN", body, comments: [] };
  const verdicts = "AC-1: met — a\nAC-2: met — b";
  const merged: ReferencingPull = {
    number: 62,
    merged: true,
    mergedAt: "2026-11-11T10:00:00Z",
    baseRefName: "develop",
    headRefOid: NEW,
    body: "Issue: #61",
    comments: [plain(OLD, verdicts), carried(NEW, OLD, verdicts)],
  };
  const close = (carries: Map<number, CarryJudgement>): Plan =>
    planClose(issue, "Evidence", field, { itemId: "I", status: "In Review" }, [merged], carries);

  it("ticks the AC copied into a verified carried PASS", () => {
    const plan = close(new Map([[62, ok]]));
    expect(plan.kind).toBe("run");
    expect(plan.kind === "run" && plan.steps[0]?.input).toContain("- [x] one");
  });

  it("refuses a carried PASS whose head is not a clean sync", () => {
    expect(close(new Map([[62, bad]]))).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(/PR #62 wrong-head PASS.*differs/) as unknown,
    });
  });

  it("refuses a carried PASS that was never judged", () => {
    expect(close(new Map()).kind).toBe("refuse");
  });

  it("still takes the AC lines from a verified PASS only when every line is met", () => {
    const partial = { ...merged, comments: [carried(NEW, OLD, "AC-1: met — a")] };
    const plan = planClose(
      issue,
      "Evidence",
      field,
      { itemId: "I", status: "In Review" },
      [partial],
      new Map([[62, ok]]),
    );
    expect(plan).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(/no line for AC-2/) as unknown,
    });
  });
});
