import { describe, expect, it, vi } from "vitest";
import { INITIAL_REWORK_STATE } from "../../../../../src/domain/runs/rework-policy.ts";
import type { ReworkState } from "../../../../../src/domain/runs/rework-policy.ts";
import { recordReworkEvent } from "../../../../../src/application/use-cases/runs/record-rework-event.ts";
import type { RecordReworkEventDependencies } from "../../../../../src/application/use-cases/runs/record-rework-event.ts";

function setup(rework: ReworkState = INITIAL_REWORK_STATE) {
  const commit = vi.fn<RecordReworkEventDependencies["session"]["commit"]>(() => ({
    ok: true,
    newVersion: 1,
    eventSequence: 1,
  }));
  const checkpoint = vi.fn<RecordReworkEventDependencies["checkpoint"]>(() => ({
    ok: true,
    checkpointId: "checkpoint",
  }));
  const renew = vi.fn(() => true);
  const deps: RecordReworkEventDependencies = {
    runs: { get: () => ({ id: "run", taskId: "task", status: "running", version: 0, rework }) },
    session: {
      lease: {
        resourceKey: "project-owner",
        owner: "owner",
        generation: 1,
        acquiredAt: "t",
        expiresAt: "t",
      },
      commit,
      renew,
      record: () => {},
      release: () => {},
    },
    checkpoint,
    nextId: () => "event",
  };
  return { deps, commit, checkpoint, renew };
}
const failure = { runId: "run", event: { type: "cycle_failed", cycleId: "c4", kind: "quality" } };
const assisted: ReworkState = {
  ...INITIAL_REWORK_STATE,
  phase: "assisted",
  failedCycles: 1,
  architectInterventionId: "arch",
};

describe("recordReworkEvent", () => {
  it("refuses malformed input and a lost project lease before doing work", () => {
    const r = setup();
    expect(recordReworkEvent(r.deps, {})).toMatchObject({ reason: "INVALID_INPUT" });
    r.renew.mockReturnValue(false);
    expect(recordReworkEvent(r.deps, failure)).toMatchObject({ reason: "PROJECT_LOCK_LOST" });
    expect(r.commit).not.toHaveBeenCalled();
  });
  it("requires a saved checkpoint before committing Blocked", () => {
    const r = setup(assisted);
    r.checkpoint.mockReturnValue({ ok: false });
    expect(recordReworkEvent(r.deps, failure)).toEqual({ ok: false, reason: "CHECKPOINT_FAILED" });
    expect(r.commit).not.toHaveBeenCalled();
    r.checkpoint.mockReturnValue({ ok: true, checkpointId: "checkpoint" });
    expect(recordReworkEvent(r.deps, failure)).toMatchObject({ action: "blocked" });
    expect(r.commit.mock.calls[0]?.[0].target).toMatchObject({
      toStatus: "blocked",
      rework: { failedCycles: 2, phase: "blocked" },
    });
  });
  it("returns a CAS rejection instead of claiming escalation", () => {
    const r = setup({ ...INITIAL_REWORK_STATE, failedCycles: 1 });
    r.commit.mockReturnValue({ ok: false, reason: "STALE_VERSION" });
    expect(recordReworkEvent(r.deps, failure)).toEqual({ ok: false, reason: "STALE_VERSION" });
  });
  it("does not checkpoint or persist infrastructure failures", () => {
    const r = setup(assisted);
    expect(
      recordReworkEvent(r.deps, {
        ...failure,
        event: { ...failure.event, kind: "infrastructure" },
      }),
    ).toMatchObject({ reason: "INFRASTRUCTURE_FAILURE_NOT_QUALITY" });
    expect(r.commit).not.toHaveBeenCalled();
    expect(r.checkpoint).not.toHaveBeenCalled();
  });
  it("never completes a workflow or task merely because a quality gate passed", () => {
    const r = setup(assisted);
    expect(
      recordReworkEvent(r.deps, { runId: "run", event: { type: "gate_passed" } }),
    ).toMatchObject({ action: "passed" });
    expect(r.commit.mock.calls[0]?.[0].target).toMatchObject({
      toStatus: "running",
      rework: { phase: "passed" },
    });
  });
});
