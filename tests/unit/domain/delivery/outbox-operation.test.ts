import { describe, expect, it } from "vitest";
import {
  OUTBOX_RULES,
  OUTBOX_STATES,
  isOutboxState,
  isTerminalOutboxState,
  transitionOutbox,
} from "../../../../src/domain/delivery/outbox-operation.ts";
import type { OutboxEvent } from "../../../../src/domain/delivery/outbox-operation.ts";

const events = {
  begin_attempt: { type: "begin_attempt", now: 100, notBefore: 0, attemptCount: 0, maxAttempts: 3 },
  attempt_succeeded: { type: "attempt_succeeded", remoteIdentity: "issue_comment:acme/app:1" },
  attempt_rejected_retry: { type: "attempt_rejected_retry" },
  attempt_rejected_final: { type: "attempt_rejected_final" },
  attempt_outcome_unknown: { type: "attempt_outcome_unknown" },
  reconciled_found: { type: "reconciled_found", remoteIdentity: "issue_comment:acme/app:1" },
  reconciled_absent: {
    type: "reconciled_absent",
    now: 1_000,
    outcomeUnknownSince: 0,
    graceMs: 500,
  },
  give_up: { type: "give_up", reason: "RETRY_BUDGET_EXHAUSTED" },
  reopen: { type: "reopen", decisionId: "decision-1" },
} satisfies Record<OutboxEvent["type"], OutboxEvent>;

describe("outbox operation state machine", () => {
  it("accepts exactly the declared transitions", () => {
    for (const from of OUTBOX_STATES) {
      for (const event of Object.values(events)) {
        const declared = OUTBOX_RULES.find((r) => r.from === from && r.event === event.type);
        const outcome = transitionOutbox(from, event);
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

  it("only ever starts a send from pending", () => {
    const entering = OUTBOX_RULES.filter((r) => r.to === "in_flight");
    expect(entering.map((r) => [r.from, r.event])).toEqual([["pending", "begin_attempt"]]);
  });

  it("never returns from an unknown outcome to a send without a read-back", () => {
    // outcome_unknown can only reach pending through reconciled_absent, and succeeded through
    // reconciled_found. Anything else would allow a duplicate after a timeout-after-success.
    const exits = OUTBOX_RULES.filter((r) => r.from === "outcome_unknown");
    expect(exits.map((r) => [r.event, r.to])).toEqual([
      ["reconciled_found", "succeeded"],
      ["reconciled_absent", "pending"],
    ]);
  });

  it("keeps succeeded final and failed reopenable only by decision", () => {
    expect(OUTBOX_RULES.filter((r) => r.from === "succeeded")).toEqual([]);
    expect(OUTBOX_RULES.filter((r) => r.from === "failed").map((r) => r.event)).toEqual(["reopen"]);
    expect(OUTBOX_STATES.filter(isTerminalOutboxState)).toEqual(["succeeded", "failed"]);
  });

  describe("preconditions", () => {
    it("refuses a send before Retry-After or backoff has passed", () => {
      expect(
        transitionOutbox("pending", { ...events.begin_attempt, now: 99, notBefore: 100 }),
      ).toMatchObject({ ok: false, reason: "NOT_DUE" });
      expect(
        transitionOutbox("pending", { ...events.begin_attempt, now: 100, notBefore: 100 }),
      ).toMatchObject({ ok: true, to: "in_flight" });
    });

    it("refuses a send when the attempt budget is spent", () => {
      expect(
        transitionOutbox("pending", { ...events.begin_attempt, attemptCount: 3, maxAttempts: 3 }),
      ).toMatchObject({ ok: false, reason: "RETRY_BUDGET_EXHAUSTED" });
      expect(
        transitionOutbox("pending", { ...events.begin_attempt, attemptCount: 2, maxAttempts: 3 }),
      ).toMatchObject({ ok: true });
    });

    it("requires a remote identity to record success", () => {
      for (const [from, type] of [
        ["in_flight", "attempt_succeeded"],
        ["outcome_unknown", "reconciled_found"],
      ] as const) {
        expect(transitionOutbox(from, { type, remoteIdentity: "  " })).toMatchObject({
          ok: false,
          reason: "REMOTE_IDENTITY_MISSING",
        });
      }
    });

    it("trusts an absent remote only after the grace period", () => {
      const absent = { ...events.reconciled_absent, now: 499 };
      expect(transitionOutbox("outcome_unknown", absent)).toMatchObject({
        ok: false,
        reason: "RECONCILE_TOO_EARLY",
      });
      expect(transitionOutbox("outcome_unknown", { ...absent, now: 500 })).toMatchObject({
        ok: true,
        to: "pending",
      });
    });

    it("needs a reason to give up and a decision to reopen", () => {
      expect(transitionOutbox("pending", { type: "give_up", reason: "" })).toMatchObject({
        ok: false,
        reason: "REASON_MISSING",
      });
      expect(transitionOutbox("failed", { type: "reopen", decisionId: " " })).toMatchObject({
        ok: false,
        reason: "REOPEN_DECISION_MISSING",
      });
    });
  });

  it("recognises exactly the declared states", () => {
    for (const state of OUTBOX_STATES) expect(isOutboxState(state)).toBe(true);
    expect(isOutboxState("done")).toBe(false);
    expect(isOutboxState("")).toBe(false);
  });
});
