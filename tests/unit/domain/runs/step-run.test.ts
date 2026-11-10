import { describe, expect, it } from "vitest";
import {
  STEP_RULES,
  STEP_STATUSES,
  TERMINAL_STEP_STATUSES,
  transitionStep,
} from "../../../../src/domain/runs/step-run.ts";
import type { StepEvent } from "../../../../src/domain/runs/step-run.ts";

const events = {
  dependencies_met: { type: "dependencies_met", inputsValid: true, inScope: true },
  start: { type: "start", leaseHeld: true, executorEligible: true, contextSaved: true },
  succeed: {
    type: "succeed",
    attempt: 2,
    currentAttempt: 2,
    resultValid: true,
    stepGatePassed: true,
  },
  fail: { type: "fail", attempt: 2, currentAttempt: 2 },
  interrupt: { type: "interrupt", attempt: 2, currentAttempt: 2 },
  wait_resource: {
    type: "wait_resource",
    attempt: 2,
    currentAttempt: 2,
    previousWriterStopped: true,
  },
  wait_approval: { type: "wait_approval" },
  approval_granted: { type: "approval_granted", approvalValid: true },
  resource_available: { type: "resource_available", candidateAvailable: true },
  reconciled: {
    type: "reconciled",
    reconciliationDone: true,
    oldProcessGone: true,
    checkpointValid: true,
  },
  retry_authorized: { type: "retry_authorized", reworkAllowsRetry: true },
  pause: { type: "pause", writerStopped: true },
  resume: { type: "resume", checkpointValid: true },
  cancel: { type: "cancel", writerStopped: true },
} satisfies Record<StepEvent["type"], StepEvent>;

describe("step state machine", () => {
  it("accepts exactly the transitions in the table and refuses every other pair", () => {
    for (const from of STEP_STATUSES) {
      for (const event of Object.values(events)) {
        const declared = STEP_RULES.find((r) => r.from === from && r.event === event.type);
        const outcome = transitionStep(from, event);
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

  it("has no way out of succeeded or cancelled", () => {
    for (const from of TERMINAL_STEP_STATUSES) {
      expect(STEP_RULES.filter((r) => r.from === from)).toEqual([]);
    }
  });

  it("has one rule per (state, event) pair", () => {
    const keys = STEP_RULES.map((r) => `${r.from}|${r.event}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("follows the main path pending -> ready -> running -> succeeded", () => {
    expect(transitionStep("pending", events.dependencies_met)).toMatchObject({ to: "ready" });
    expect(transitionStep("ready", events.start)).toMatchObject({ to: "running" });
    expect(transitionStep("running", events.succeed)).toMatchObject({ to: "succeeded" });
  });

  describe("pending -> ready", () => {
    it("refuses invalid input and out-of-scope work", () => {
      expect(
        transitionStep("pending", { type: "dependencies_met", inputsValid: false, inScope: true }),
      ).toMatchObject({ reason: "INPUT_INVALID" });
      expect(
        transitionStep("pending", { type: "dependencies_met", inputsValid: true, inScope: false }),
      ).toMatchObject({ reason: "OUT_OF_SCOPE" });
    });
  });

  describe("ready -> running", () => {
    it("needs a lease, an eligible executor and a saved context, in that order", () => {
      const base = events.start;
      expect(transitionStep("ready", { ...base, leaseHeld: false })).toMatchObject({
        reason: "LEASE_NOT_HELD",
      });
      expect(transitionStep("ready", { ...base, executorEligible: false })).toMatchObject({
        reason: "NO_ELIGIBLE_EXECUTOR",
      });
      expect(transitionStep("ready", { ...base, contextSaved: false })).toMatchObject({
        reason: "CONTEXT_NOT_SAVED",
      });
    });
  });

  describe("stale attempts", () => {
    it("never lets a late event of an older attempt change the step", () => {
      const late = { attempt: 1, currentAttempt: 2 };
      for (const event of [
        { ...events.succeed, ...late },
        { ...events.fail, ...late },
        { ...events.interrupt, ...late },
        { ...events.wait_resource, ...late },
      ]) {
        expect(transitionStep("running", event), event.type).toMatchObject({
          ok: false,
          reason: "STALE_ATTEMPT",
        });
      }
    });
  });

  describe("running -> succeeded", () => {
    it("needs a valid result and a passed step gate; the agent's claim alone is not enough", () => {
      expect(transitionStep("running", { ...events.succeed, resultValid: false })).toMatchObject({
        reason: "RESULT_INVALID",
      });
      expect(transitionStep("running", { ...events.succeed, stepGatePassed: false })).toMatchObject(
        { reason: "STEP_GATE_FAILED" },
      );
    });
  });

  describe("resource wait and interruption", () => {
    it("waits for a resource only after the previous writer stopped", () => {
      expect(
        transitionStep("running", { ...events.wait_resource, previousWriterStopped: false }),
      ).toMatchObject({ reason: "WRITER_STILL_ACTIVE" });
    });

    it("leaves waiting_resource only when a capable candidate exists", () => {
      expect(
        transitionStep("waiting_resource", {
          type: "resource_available",
          candidateAvailable: false,
        }),
      ).toMatchObject({ reason: "NO_CANDIDATE_AVAILABLE" });
    });

    it("reconciles an interrupted step only with reconciliation done, old process gone, checkpoint valid", () => {
      const base = events.reconciled;
      expect(transitionStep("interrupted", { ...base, reconciliationDone: false })).toMatchObject({
        reason: "RECONCILIATION_PENDING",
      });
      expect(transitionStep("interrupted", { ...base, oldProcessGone: false })).toMatchObject({
        reason: "OLD_PROCESS_STILL_RUNNING",
      });
      expect(transitionStep("interrupted", { ...base, checkpointValid: false })).toMatchObject({
        reason: "CHECKPOINT_INVALID",
      });
    });

    it("cannot go straight from interrupted to running", () => {
      expect(transitionStep("interrupted", events.start)).toMatchObject({
        reason: "TRANSITION_NOT_ALLOWED",
      });
    });
  });

  describe("approval and retry", () => {
    it("leaves waiting_approval only with a valid approval", () => {
      expect(
        transitionStep("waiting_approval", { type: "approval_granted", approvalValid: false }),
      ).toMatchObject({ reason: "APPROVAL_INVALID" });
    });

    it("retries a failed step only while the rework budget allows it", () => {
      expect(
        transitionStep("failed", { type: "retry_authorized", reworkAllowsRetry: false }),
      ).toMatchObject({ ok: false, reason: "REWORK_BUDGET_SPENT" });
      expect(transitionStep("failed", events.retry_authorized)).toMatchObject({ to: "ready" });
    });
  });

  describe("pause, resume, cancel", () => {
    it("pauses a running step only after its writer stopped", () => {
      expect(transitionStep("running", { type: "pause", writerStopped: false })).toMatchObject({
        reason: "WRITER_STILL_ACTIVE",
      });
      expect(transitionStep("ready", { type: "pause", writerStopped: false })).toMatchObject({
        ok: true,
        to: "paused",
      });
    });

    it("resumes only from a valid checkpoint", () => {
      expect(transitionStep("paused", { type: "resume", checkpointValid: false })).toMatchObject({
        reason: "CHECKPOINT_INVALID",
      });
    });

    it("cancels a running step only after its writer stopped, other states freely", () => {
      expect(transitionStep("running", { type: "cancel", writerStopped: false })).toMatchObject({
        reason: "WRITER_STILL_ACTIVE",
      });
      expect(
        transitionStep("waiting_approval", { type: "cancel", writerStopped: false }),
      ).toMatchObject({ to: "cancelled" });
    });
  });
});
