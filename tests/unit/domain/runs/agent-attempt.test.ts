import { describe, expect, it } from "vitest";
import {
  AGENT_ATTEMPT_STATUSES,
  transitionAgentAttempt,
} from "../../../../src/domain/runs/agent-attempt.ts";
const done = { generation: 3, currentGeneration: 3, writerStopped: true, resultValid: true };
describe("agent attempt lifecycle", () => {
  it("requires a lease to start", () => {
    expect(transitionAgentAttempt("pending", { type: "start", leaseHeld: false })).toMatchObject({
      ok: false,
      reason: "LEASE_NOT_HELD",
    });
    expect(transitionAgentAttempt("pending", { type: "start", leaseHeld: true })).toMatchObject({
      ok: true,
      to: "running",
    });
  });
  it("permits exactly the declared lifecycle, with no retry or resurrection of a terminal attempt", () => {
    const targets = {
      succeed: "succeeded",
      fail: "failed",
      interrupt: "interrupted",
      cancel: "cancelled",
    } as const;
    for (const status of AGENT_ATTEMPT_STATUSES) {
      for (const type of Object.keys(targets) as (keyof typeof targets)[]) {
        const result = transitionAgentAttempt(status, { type, ...done });
        if (status === "running" || (status === "pending" && type === "cancel"))
          expect(result).toMatchObject({ ok: true, to: targets[type] });
        else expect(result).toMatchObject({ ok: false, reason: "TRANSITION_NOT_ALLOWED" });
      }
      if (status !== "pending")
        expect(transitionAgentAttempt(status, { type: "start", leaseHeld: true }).ok).toBe(false);
    }
  });
  it("rejects stale completions and refuses to finish before the writer stops", () => {
    for (const type of ["succeed", "fail", "interrupt", "cancel"] as const) {
      expect(transitionAgentAttempt("running", { type, ...done, generation: 2 })).toMatchObject({
        ok: false,
        reason: "STALE_GENERATION",
      });
      expect(
        transitionAgentAttempt("running", { type, ...done, writerStopped: false }),
      ).toMatchObject({ ok: false, reason: "WRITER_STILL_ACTIVE" });
    }
    expect(
      transitionAgentAttempt("running", { type: "succeed", ...done, resultValid: false }),
    ).toMatchObject({ ok: false, reason: "RESULT_INVALID" });
  });
});
