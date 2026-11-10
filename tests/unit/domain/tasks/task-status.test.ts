import { describe, expect, it } from "vitest";
import {
  TASK_RULES,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  transitionTask,
} from "../../../../src/domain/tasks/task-status.ts";
import type { TaskEvent, TaskStatus } from "../../../../src/domain/tasks/task-status.ts";

const events = {
  dependencies_satisfied: {
    type: "dependencies_satisfied",
    dependenciesDone: true,
    inputValid: true,
    inScope: true,
  },
  run_started: { type: "run_started", otherActiveRunExists: false },
  run_replaced: { type: "run_replaced", previousRunClosed: true },
  completion_confirmed: {
    type: "completion_confirmed",
    acceptanceMet: true,
    changesCode: true,
    mergeConfirmed: true,
    outputAccepted: false,
  },
  quality_budget_exhausted: { type: "quality_budget_exhausted", checkpointSaved: true },
  dependency_blocked: { type: "dependency_blocked" },
  dependency_recovered: { type: "dependency_recovered", anyPredecessorBlocked: false },
  po_reopened: { type: "po_reopened", poDecisionId: "decision-1", dependenciesDone: true },
  cancelled: { type: "cancelled", runStopped: true },
} satisfies Record<TaskEvent["type"], TaskEvent>;

describe("task state machine", () => {
  it("accepts exactly the transitions in the table and refuses every other pair", () => {
    for (const from of TASK_STATUSES) {
      for (const event of Object.values(events)) {
        const declared = TASK_RULES.find((r) => r.from === from && r.event === event.type);
        const outcome = transitionTask(from, event);
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

  it("has no outgoing transition from done or cancelled", () => {
    for (const from of TERMINAL_TASK_STATUSES) {
      expect(TASK_RULES.filter((r) => r.from === from)).toEqual([]);
    }
  });

  it("has one rule per (state, event) pair", () => {
    const keys = TASK_RULES.map((r) => `${r.from}|${r.event}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("pending -> ready needs dependencies done, valid input and scope, with distinct reasons", () => {
    const base = events.dependencies_satisfied;
    expect(transitionTask("pending", { ...base, dependenciesDone: false })).toMatchObject({
      reason: "DEPENDENCIES_NOT_DONE",
    });
    expect(transitionTask("pending", { ...base, inputValid: false })).toMatchObject({
      reason: "INPUT_INVALID",
    });
    expect(transitionTask("pending", { ...base, inScope: false })).toMatchObject({
      reason: "OUT_OF_SCOPE",
    });
  });

  it("allows only one active run per task", () => {
    expect(
      transitionTask("ready", { type: "run_started", otherActiveRunExists: true }),
    ).toMatchObject({ ok: false, reason: "ACTIVE_RUN_EXISTS" });
  });

  describe("Done", () => {
    const done = events.completion_confirmed;

    it("needs the confirmed merge for a code task, whatever the agent reported", () => {
      expect(transitionTask("in_progress", { ...done, mergeConfirmed: false })).toMatchObject({
        ok: false,
        reason: "MERGE_NOT_CONFIRMED",
      });
      expect(transitionTask("in_progress", done)).toMatchObject({ ok: true, to: "done" });
    });

    it("needs accepted output for a task without code, not a merge", () => {
      const noCode = { ...done, changesCode: false, mergeConfirmed: false };
      expect(transitionTask("in_progress", { ...noCode, outputAccepted: false })).toMatchObject({
        reason: "OUTPUT_NOT_ACCEPTED",
      });
      expect(transitionTask("in_progress", { ...noCode, outputAccepted: true })).toMatchObject({
        ok: true,
        to: "done",
      });
    });

    it("needs acceptance criteria met first", () => {
      expect(transitionTask("in_progress", { ...done, acceptanceMet: false })).toMatchObject({
        reason: "ACCEPTANCE_NOT_MET",
      });
    });

    it("cannot skip in_progress", () => {
      expect(transitionTask("ready", done)).toMatchObject({
        ok: false,
        reason: "TRANSITION_NOT_ALLOWED",
      });
    });
  });

  describe("blocking", () => {
    it("stops a task whose quality budget is spent only with a saved checkpoint", () => {
      expect(
        transitionTask("in_progress", { type: "quality_budget_exhausted", checkpointSaved: false }),
      ).toMatchObject({ reason: "CHECKPOINT_MISSING" });
      expect(transitionTask("in_progress", events.quality_budget_exhausted)).toMatchObject({
        ok: true,
        to: "blocked",
      });
    });

    it("blocks dependents of a stopped task and frees them only when no predecessor is blocked", () => {
      expect(transitionTask("pending", events.dependency_blocked)).toMatchObject({
        to: "blocked_by_dependency",
      });
      expect(
        transitionTask("blocked_by_dependency", {
          type: "dependency_recovered",
          anyPredecessorBlocked: true,
        }),
      ).toMatchObject({ reason: "PREDECESSOR_STILL_BLOCKED" });
      expect(transitionTask("blocked_by_dependency", events.dependency_recovered)).toMatchObject({
        to: "pending",
      });
    });

    it("does not let dependency recovery reopen a task stopped for quality", () => {
      expect(transitionTask("blocked", events.dependency_recovered)).toMatchObject({
        ok: false,
        reason: "TRANSITION_NOT_ALLOWED",
      });
    });

    it("reopens a blocked task only on a recorded PO decision", () => {
      expect(
        transitionTask("blocked", {
          type: "po_reopened",
          poDecisionId: "  ",
          dependenciesDone: true,
        }),
      ).toMatchObject({ reason: "REOPEN_DECISION_MISSING" });
      expect(
        transitionTask("blocked", {
          type: "po_reopened",
          poDecisionId: "d-1",
          dependenciesDone: false,
        }),
      ).toMatchObject({ reason: "DEPENDENCIES_NOT_DONE" });
      expect(transitionTask("blocked", events.po_reopened)).toMatchObject({ to: "ready" });
    });
  });

  it("cancels an in-progress task only after its run has stopped", () => {
    expect(transitionTask("in_progress", { type: "cancelled", runStopped: false })).toMatchObject({
      reason: "RUN_STILL_ACTIVE",
    });
    for (const from of ["pending", "ready", "blocked", "blocked_by_dependency"] as TaskStatus[]) {
      expect(transitionTask(from, { type: "cancelled", runStopped: false })).toMatchObject({
        ok: true,
        to: "cancelled",
      });
    }
  });
});
