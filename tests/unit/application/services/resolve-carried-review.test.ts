import { describe, expect, it } from "vitest";
import type { MergeEvidence } from "../../../../src/application/contracts/merge-delivery.ts";
import { resolveCarriedEvidence } from "../../../../src/application/services/resolve-carried-review.ts";
import type { CarryFacts } from "../../../../src/domain/delivery/carried-pass-policy.ts";

const REVIEWED = "a".repeat(40);
const SYNC1 = "b".repeat(40);
const SYNC2 = "c".repeat(40);
const BASE1 = "1".repeat(40);
const BASE2 = "2".repeat(40);
const TREE = "d".repeat(40);

const base: MergeEvidence = {
  authorRunIds: ["run-impl"],
  authorAgentIds: ["impl"],
  unresolvedMandatoryFindings: 0,
  workflowGatesPassed: true,
};
const review = (headSha: string, verdict: "pass" | "fail" = "pass") => ({
  reviewerRunId: "run-review",
  reviewerAgentId: "reviewer",
  headSha,
  baseSha: "9".repeat(40),
  verdict,
  body: "AC-1: met — x",
});
const sync = (head: string, parent: string, base1: string, over: Partial<CarryFacts> = {}) => ({
  head,
  parents: [parent, base1],
  secondParentOnBase: true,
  headTree: TREE,
  mergeTree: TREE,
  ...over,
});

function deps(facts: Record<string, CarryFacts>, reviews: Record<string, MergeEvidence["review"]>) {
  return {
    evidence: {
      read: (_p: string, _t: string, head: string) => ({ ...base, review: reviews[head] }),
    },
    sync: {
      facts: (commit: string): CarryFacts => {
        const found = facts[commit];
        if (found === undefined) throw new Error("unreadable");
        return found;
      },
    },
  };
}

describe("resolveCarriedEvidence", () => {
  it("returns a review on the head itself unchanged", () => {
    const d = deps({}, { [REVIEWED]: review(REVIEWED) });
    expect(resolveCarriedEvidence(d, "p", "t", REVIEWED).review?.headSha).toBe(REVIEWED);
  });

  it("carries the PASS over a clean sync, pinned to the head and the merged base commit", () => {
    const d = deps({ [SYNC1]: sync(SYNC1, REVIEWED, BASE1) }, { [REVIEWED]: review(REVIEWED) });
    expect(resolveCarriedEvidence(d, "p", "t", SYNC1).review).toMatchObject({
      headSha: SYNC1,
      baseSha: BASE1,
      verdict: "pass",
      reviewerRunId: "run-review",
    });
  });

  it("walks a chain of clean syncs and pins the newest base commit", () => {
    const d = deps(
      { [SYNC2]: sync(SYNC2, SYNC1, BASE2), [SYNC1]: sync(SYNC1, REVIEWED, BASE1) },
      { [REVIEWED]: review(REVIEWED) },
    );
    expect(resolveCarriedEvidence(d, "p", "t", SYNC2).review).toMatchObject({
      headSha: SYNC2,
      baseSha: BASE2,
    });
  });

  it.each([
    ["a hand-edited merge", { headTree: "e".repeat(40) }],
    ["a conflicting merge", { mergeTree: null }],
    ["a base commit that is not on develop", { secondParentOnBase: false }],
  ] as const)("gives no review for %s", (_name, over) => {
    const d = deps(
      { [SYNC1]: sync(SYNC1, REVIEWED, BASE1, over) },
      { [REVIEWED]: review(REVIEWED) },
    );
    expect(resolveCarriedEvidence(d, "p", "t", SYNC1).review).toBeUndefined();
  });

  it("gives no review when the reviewed commit has a FAIL, or git cannot read the head", () => {
    const failed = deps(
      { [SYNC1]: sync(SYNC1, REVIEWED, BASE1) },
      { [REVIEWED]: review(REVIEWED, "fail") },
    );
    expect(resolveCarriedEvidence(failed, "p", "t", SYNC1).review).toBeUndefined();
    const unreadable = deps({}, { [REVIEWED]: review(REVIEWED) });
    expect(resolveCarriedEvidence(unreadable, "p", "t", SYNC1).review).toBeUndefined();
  });
});
