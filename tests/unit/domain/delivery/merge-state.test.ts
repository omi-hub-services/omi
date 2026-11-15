import { describe, expect, it } from "vitest";
import {
  MERGE_RULES,
  MERGE_STATUSES,
  transitionMerge,
} from "../../../../src/domain/delivery/merge-state.ts";
import type { MergeEvent } from "../../../../src/domain/delivery/merge-state.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

const events = {
  gates_passed: { type: "gates_passed", evaluatedHeadSha: HEAD, currentHeadSha: HEAD },
  revision_changed: { type: "revision_changed" },
  merge_requested: {
    type: "merge_requested",
    decisionAllowed: true,
    expectedHeadSha: HEAD,
    currentHeadSha: HEAD,
  },
  merge_confirmed: { type: "merge_confirmed", remoteMerged: true, mergeCommitSha: "m".repeat(40) },
  merge_rejected: { type: "merge_rejected" },
  merge_outcome_unknown: { type: "merge_outcome_unknown" },
  reconciled_merged: { type: "reconciled_merged", remoteMerged: true },
  reconciled_not_merged: { type: "reconciled_not_merged", remoteMerged: false },
} satisfies Record<MergeEvent["type"], MergeEvent>;

describe("merge state machine", () => {
  it("accepts exactly the declared transitions", () => {
    for (const from of MERGE_STATUSES) {
      for (const event of Object.values(events)) {
        const declared = MERGE_RULES.find((r) => r.from === from && r.event === event.type);
        const outcome = transitionMerge(from, event);
        if (declared === undefined) {
          expect(outcome, `${from} + ${event.type}`).toMatchObject({
            ok: false,
            reason: "TRANSITION_NOT_ALLOWED",
          });
        } else {
          expect(outcome, `${from} + ${event.type}`).toEqual({ ok: true, from, to: declared.to });
        }
      }
    }
  });

  it("has no way out of merged", () => {
    expect(MERGE_RULES.filter((r) => r.from === "merged")).toEqual([]);
  });

  it("walks not_ready -> ready -> merge_requested -> merged", () => {
    expect(transitionMerge("not_ready", events.gates_passed)).toMatchObject({ to: "ready" });
    expect(transitionMerge("ready", events.merge_requested)).toMatchObject({
      to: "merge_requested",
    });
    expect(transitionMerge("merge_requested", events.merge_confirmed)).toMatchObject({
      to: "merged",
    });
  });

  it("refuses gates evaluated on a head that is no longer current", () => {
    expect(
      transitionMerge("not_ready", { ...events.gates_passed, currentHeadSha: OTHER }),
    ).toMatchObject({ reason: "STALE_REVISION" });
  });

  it("falls back to not_ready when the revision changes, so evidence is gathered again", () => {
    expect(transitionMerge("ready", events.revision_changed)).toMatchObject({ to: "not_ready" });
  });

  it("requests a merge only when the policy allowed it and the head is still the expected one", () => {
    expect(
      transitionMerge("ready", { ...events.merge_requested, decisionAllowed: false }),
    ).toMatchObject({ reason: "MERGE_NOT_ALLOWED" });
    expect(
      transitionMerge("ready", { ...events.merge_requested, currentHeadSha: OTHER }),
    ).toMatchObject({ reason: "STALE_REVISION" });
  });

  it("cannot request a merge from not_ready", () => {
    expect(transitionMerge("not_ready", events.merge_requested)).toMatchObject({
      reason: "TRANSITION_NOT_ALLOWED",
    });
  });

  describe("confirmation", () => {
    it("is merged only when the remote says so and a merge commit is known", () => {
      expect(
        transitionMerge("merge_requested", { ...events.merge_confirmed, remoteMerged: false }),
      ).toMatchObject({ reason: "REMOTE_NOT_MERGED" });
      expect(
        transitionMerge("merge_requested", { ...events.merge_confirmed, mergeCommitSha: "" }),
      ).toMatchObject({ reason: "MERGE_COMMIT_MISSING" });
    });
  });

  describe("timeout after the remote may already have merged", () => {
    it("moves to merge_unknown and offers no second merge call from there", () => {
      expect(transitionMerge("merge_requested", events.merge_outcome_unknown)).toMatchObject({
        to: "merge_unknown",
      });
      expect(transitionMerge("merge_unknown", events.merge_requested)).toMatchObject({
        ok: false,
        reason: "TRANSITION_NOT_ALLOWED",
      });
    });

    it("exits only through a remote read-back that agrees with the claim", () => {
      expect(transitionMerge("merge_unknown", events.reconciled_merged)).toMatchObject({
        to: "merged",
      });
      expect(
        transitionMerge("merge_unknown", { type: "reconciled_merged", remoteMerged: false }),
      ).toMatchObject({ reason: "REMOTE_NOT_MERGED" });
      expect(transitionMerge("merge_unknown", events.reconciled_not_merged)).toMatchObject({
        to: "not_ready",
      });
      expect(
        transitionMerge("merge_unknown", { type: "reconciled_not_merged", remoteMerged: true }),
      ).toMatchObject({ reason: "REMOTE_ALREADY_MERGED" });
    });
  });
});
