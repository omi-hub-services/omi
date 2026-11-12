import { describe, expect, it } from "vitest";
import {
  judgeCarriedHead,
  type CarryFacts,
} from "../../../../src/domain/delivery/carried-pass-policy.ts";

const REVIEWED = "a".repeat(40);
const DEVELOP = "b".repeat(40);
const HEAD = "c".repeat(40);
const TREE = "d".repeat(40);

const facts = (over: Partial<CarryFacts> = {}): CarryFacts => ({
  head: HEAD,
  parents: [REVIEWED, DEVELOP],
  secondParentOnBase: true,
  headTree: TREE,
  mergeTree: TREE,
  ...over,
});

describe("judgeCarriedHead", () => {
  it("accepts the automatic merge of the reviewed commit and a base commit", () => {
    expect(judgeCarriedHead(facts(), REVIEWED)).toEqual({ ok: true, baseCommit: DEVELOP });
  });

  it("accepts an abbreviated reviewed SHA", () => {
    expect(judgeCarriedHead(facts(), REVIEWED.slice(0, 7))).toMatchObject({ ok: true });
  });

  it.each([
    ["is not a merge commit", { parents: [REVIEWED] }, "not a merge commit"],
    ["has another first parent", { parents: [DEVELOP, REVIEWED] }, "not the reviewed"],
    ["merges a commit that is not on the base branch", { secondParentOnBase: false }, "not on"],
    ["came from a merge that conflicts", { mergeTree: null }, "conflicts"],
    ["was edited by hand", { headTree: "e".repeat(40) }, "differs from the automatic merge"],
  ] as const)("refuses a head that %s", (_name, over, reason) => {
    const judged = judgeCarriedHead(facts(over), REVIEWED);
    expect(judged.ok).toBe(false);
    expect(judged.ok ? "" : judged.reason).toContain(reason);
  });
});
