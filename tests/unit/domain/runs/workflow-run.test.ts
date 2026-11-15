import { describe, expect, it } from "vitest";
import {
  RUN_RULES,
  RUN_STATUSES,
  transitionRun,
} from "../../../../src/domain/runs/workflow-run.ts";
import type { RunEvent } from "../../../../src/domain/runs/workflow-run.ts";

const events = {
  start: { type: "start", templateHash: "sha256:abc", otherActiveRunForTask: false },
  wait_approval: { type: "wait_approval" },
  approval_granted: { type: "approval_granted", approvalValid: true },
  wait_resource: { type: "wait_resource", writerStopped: true },
  resource_available: { type: "resource_available", candidateAvailable: true },
  pause: { type: "pause", checkpointSaved: true, writerStopped: true },
  resume: { type: "resume", checkpointValid: true },
  interrupt: { type: "interrupt" },
  reconciled: {
    type: "reconciled",
    reconciliationDone: true,
    oldProcessGone: true,
    checkpointValid: true,
  },
  complete: { type: "complete", allStepsSucceeded: true, mandatoryGatesPassed: true },
  block: { type: "block", checkpointSaved: true },
  reopen: { type: "reopen", poDecisionId: "d-1" },
  cancel: { type: "cancel", writerStopped: true },
} satisfies Record<RunEvent["type"], RunEvent>;

describe("workflow run state machine", () => {
  it("accepts exactly the transitions in the table and refuses every other pair", () => {
    for (const from of RUN_STATUSES) {
      for (const event of Object.values(events)) {
        const declared = RUN_RULES.find((r) => r.from === from && r.event === event.type);
        const outcome = transitionRun(from, event);
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

  it("has no way out of succeeded or cancelled and one rule per pair", () => {
    for (const from of ["succeeded", "cancelled"] as const) {
      expect(RUN_RULES.filter((r) => r.from === from)).toEqual([]);
    }
    const keys = RUN_RULES.map((r) => `${r.from}|${r.event}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("starts only with a pinned template and no other active run for the task", () => {
    expect(transitionRun("pending", { ...events.start, templateHash: " " })).toMatchObject({
      reason: "TEMPLATE_NOT_PINNED",
    });
    expect(
      transitionRun("pending", { ...events.start, otherActiveRunForTask: true }),
    ).toMatchObject({ reason: "ACTIVE_RUN_EXISTS" });
  });

  it("completes only when every step succeeded and every mandatory gate passed", () => {
    expect(
      transitionRun("running", {
        type: "complete",
        allStepsSucceeded: false,
        mandatoryGatesPassed: true,
      }),
    ).toMatchObject({ reason: "STEPS_NOT_SUCCEEDED" });
    expect(
      transitionRun("running", {
        type: "complete",
        allStepsSucceeded: true,
        mandatoryGatesPassed: false,
      }),
    ).toMatchObject({ reason: "MANDATORY_GATE_NOT_PASSED" });
    expect(transitionRun("running", events.complete)).toMatchObject({ to: "succeeded" });
  });

  it("pauses with a saved checkpoint and a stopped writer, from any waiting state", () => {
    expect(
      transitionRun("running", { type: "pause", checkpointSaved: false, writerStopped: true }),
    ).toMatchObject({ reason: "CHECKPOINT_MISSING" });
    expect(
      transitionRun("running", { type: "pause", checkpointSaved: true, writerStopped: false }),
    ).toMatchObject({ reason: "WRITER_STILL_ACTIVE" });
    for (const from of ["waiting_approval", "waiting_resource"] as const) {
      expect(transitionRun(from, events.pause)).toMatchObject({ to: "paused" });
    }
  });

  it("resumes an interrupted run only after reconciliation, never straight back to running", () => {
    expect(transitionRun("interrupted", events.resume)).toMatchObject({
      reason: "TRANSITION_NOT_ALLOWED",
    });
    expect(
      transitionRun("interrupted", { ...events.reconciled, reconciliationDone: false }),
    ).toMatchObject({ reason: "RECONCILIATION_PENDING" });
    expect(
      transitionRun("interrupted", { ...events.reconciled, oldProcessGone: false }),
    ).toMatchObject({ reason: "OLD_PROCESS_STILL_RUNNING" });
  });

  it("blocks with a checkpoint and reopens only on a PO decision", () => {
    expect(transitionRun("running", { type: "block", checkpointSaved: false })).toMatchObject({
      reason: "CHECKPOINT_MISSING",
    });
    expect(transitionRun("blocked", { type: "reopen", poDecisionId: "" })).toMatchObject({
      reason: "REOPEN_DECISION_MISSING",
    });
    expect(transitionRun("blocked", events.reopen)).toMatchObject({ to: "running" });
  });

  it("waits for approval or resource and leaves only on the matching valid fact", () => {
    expect(
      transitionRun("waiting_approval", { type: "approval_granted", approvalValid: false }),
    ).toMatchObject({ reason: "APPROVAL_INVALID" });
    expect(
      transitionRun("waiting_resource", { type: "resource_available", candidateAvailable: false }),
    ).toMatchObject({ reason: "NO_CANDIDATE_AVAILABLE" });
    expect(transitionRun("running", { type: "wait_resource", writerStopped: false })).toMatchObject(
      { reason: "WRITER_STILL_ACTIVE" },
    );
  });
});
