import type { ApprovalRequest } from "../../../../../src/domain/approvals/approval.ts";
import { describe, expect, it, vi } from "vitest";
import { INITIAL_REWORK_STATE } from "../../../../../src/domain/runs/rework-policy.ts";
import type { ReworkState } from "../../../../../src/domain/runs/rework-policy.ts";
import {
  recordReworkEvent,
  recordReworkDecision,
} from "../../../../../src/application/use-cases/runs/record-rework-event.ts";
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
  it("refuses a PO reopen without a verified runtime approval", async () => {
    const r = setup({ ...assisted, phase: "blocked", failedCycles: 2 });
    r.deps.runs.get = () => ({
      id: "run",
      taskId: "task",
      status: "blocked",
      version: 0,
      rework: { ...assisted, phase: "blocked", failedCycles: 2 },
    });
    expect(
      await recordReworkEvent(r.deps, {
        runId: "run",
        event: { type: "po_reopened", poDecisionId: "invented" },
      }),
    ).toEqual({ ok: false, reason: "APPROVAL_REQUIRED" });
    expect(r.commit).not.toHaveBeenCalled();
  });
  it("refuses malformed input and a lost project lease before doing work", async () => {
    const r = setup();
    expect(await recordReworkEvent(r.deps, {})).toMatchObject({ reason: "INVALID_INPUT" });
    r.renew.mockReturnValue(false);
    expect(await recordReworkEvent(r.deps, failure)).toMatchObject({ reason: "PROJECT_LOCK_LOST" });
    expect(r.commit).not.toHaveBeenCalled();
  });
  it("requires a saved checkpoint before committing Blocked", async () => {
    const r = setup(assisted);
    r.checkpoint.mockReturnValue({ ok: false });
    expect(await recordReworkEvent(r.deps, failure)).toEqual({
      ok: false,
      reason: "CHECKPOINT_FAILED",
    });
    expect(r.commit).not.toHaveBeenCalled();
    r.checkpoint.mockReturnValue({ ok: true, checkpointId: "checkpoint" });
    expect(await recordReworkEvent(r.deps, failure)).toMatchObject({ action: "blocked" });
    expect(r.commit.mock.calls[0]?.[0].target).toMatchObject({
      toStatus: "blocked",
      rework: { failedCycles: 2, phase: "blocked" },
    });
  });
  it("returns a CAS rejection instead of claiming escalation", async () => {
    const r = setup({ ...INITIAL_REWORK_STATE, failedCycles: 1 });
    r.commit.mockReturnValue({ ok: false, reason: "STALE_VERSION" });
    expect(await recordReworkEvent(r.deps, failure)).toEqual({
      ok: false,
      reason: "STALE_VERSION",
    });
  });
  it("does not checkpoint or persist infrastructure failures", async () => {
    const r = setup(assisted);
    expect(
      await recordReworkEvent(r.deps, {
        ...failure,
        event: { ...failure.event, kind: "infrastructure" },
      }),
    ).toMatchObject({ reason: "INFRASTRUCTURE_FAILURE_NOT_QUALITY" });
    expect(r.commit).not.toHaveBeenCalled();
    expect(r.checkpoint).not.toHaveBeenCalled();
  });
  it("never completes a workflow or task merely because a quality gate passed", async () => {
    const r = setup(assisted);
    expect(
      await recordReworkEvent(r.deps, { runId: "run", event: { type: "gate_passed" } }),
    ).toMatchObject({ action: "passed" });
    expect(r.commit.mock.calls[0]?.[0].target).toMatchObject({
      toStatus: "running",
      rework: { phase: "passed" },
    });
  });
});

const subject = { kind: "business" as const, baselineHash: "a".repeat(64), scopeIds: ["task"] };
const approved: ApprovalRequest = {
  id: "decision",
  subjectId: "task",
  runId: "run",
  subjectHash: subject.baselineHash,
  subject,
  status: "approved",
  version: 1,
  requestedAt: 1,
  decision: {
    id: "decision",
    subject,
    decision: "approved",
    source: "github-actor",
    actor: "po",
    evidenceRef: "comment:1",
    decidedAt: 2,
  },
};
function approvalSetup(request: ApprovalRequest | undefined = approved) {
  const r = setup();
  let run = {
    id: "run",
    taskId: "task",
    status: "blocked" as const,
    version: 0,
    rework: {
      ...assisted,
      phase: "blocked" as const,
      failedCycles: 2,
      countedCycleIds: ["c1", "c2", "c3", "c4"],
    },
  };
  r.deps.runs.get = () => run;
  const deps = {
    ...r.deps,
    approvals: {
      store: { get: (): ApprovalRequest | undefined => request },
      subjects: { read: () => subject },
      now: () => 10,
      allowedGitHubActors: ["po"],
      authorActor: () => Promise.resolve("developer"),
    },
  };
  return {
    ...r,
    deps,
    setRun: (next: typeof run) => {
      run = next;
    },
    getRun: () => run,
  };
}
const reopen = { runId: "run", event: { type: "po_reopened", poDecisionId: "decision" } };

describe("rework approval authorization", () => {
  it.each(["rejected", "pending", "expired", "invalidated"] as const)(
    "refuses a %s request without writing",
    async (status) => {
      const r = approvalSetup({ ...approved, status });
      expect(await recordReworkEvent(r.deps, reopen)).toEqual({
        ok: false,
        reason: "APPROVAL_NOT_ACTIVE",
      });
      expect(r.commit).not.toHaveBeenCalled();
    },
  );
  it("refuses an unknown approval", async () => {
    const r = approvalSetup();
    r.deps.approvals.store.get = () => undefined;
    expect(await recordReworkEvent(r.deps, reopen)).toEqual({ ok: false, reason: "NO_APPROVAL" });
  });
  it("refuses a stale baseline", async () => {
    const r = approvalSetup();
    r.deps.approvals.subjects.read = () => ({ ...subject, baselineHash: "b".repeat(64) });
    expect(await recordReworkEvent(r.deps, reopen)).toEqual({
      ok: false,
      reason: "STALE_REVISION",
    });
  });
  it.each([
    ["wrong run", { ...approved, runId: "another" }, "SUBJECT_MISMATCH"],
    ["wrong task", { ...approved, subjectId: "another" }, "SUBJECT_MISMATCH"],
    [
      "missing scope",
      { ...approved, subject: { ...subject, scopeIds: ["other"] } },
      "SCOPE_NOT_COVERED",
    ],
    ["expired", { ...approved, expiresAt: 10 }, "EXPIRED"],
  ])("refuses %s evidence", async (_name, request, reason) => {
    const r = approvalSetup(request);
    expect(await recordReworkEvent(r.deps, reopen)).toMatchObject({ ok: false, reason });
    expect(r.commit).not.toHaveBeenCalled();
  });
  it("rejects self approval using the trusted author identity", async () => {
    const r = approvalSetup();
    r.deps.approvals.authorActor = () => Promise.resolve("PO");
    expect(await recordReworkEvent(r.deps, reopen)).toEqual({ ok: false, reason: "SELF_APPROVAL" });
    expect(r.commit).not.toHaveBeenCalled();
  });
  it("rechecks the GitHub allowlist at use time", async () => {
    const r = approvalSetup();
    r.deps.approvals.allowedGitHubActors = [];
    expect(await recordReworkEvent(r.deps, reopen)).toEqual({
      ok: false,
      reason: "ACTOR_NOT_ALLOWED",
    });
  });
  it("rejects conversation evidence even with a message reference", async () => {
    if (approved.decision === undefined) throw new Error("missing fixture decision");
    const r = approvalSetup({
      ...approved,
      decision: { ...approved.decision, source: "po-conversation" },
    });
    expect(await recordReworkEvent(r.deps, reopen)).toEqual({
      ok: false,
      reason: "SOURCE_NOT_AUTHENTICATED",
    });
  });
  it("keeps the counted history and records the consumed decision on an authorized reopen", async () => {
    const r = approvalSetup();
    expect(await recordReworkEvent(r.deps, reopen)).toMatchObject({
      ok: true,
      action: "retry",
      state: {
        phase: "normal",
        countedCycleIds: ["c1", "c2", "c3", "c4"],
        reopenDecisionIds: ["decision"],
      },
    });
    expect(r.commit.mock.calls[0]?.[0].target).toMatchObject({ toStatus: "running" });
  });
  it("refuses reuse of an already consumed reopen decision", async () => {
    const r = approvalSetup();
    r.setRun({ ...r.getRun(), rework: { ...r.getRun().rework, reopenDecisionIds: ["decision"] } });
    expect(await recordReworkEvent(r.deps, reopen)).toEqual({
      ok: false,
      reason: "APPROVAL_ALREADY_USED",
    });
  });
  it("does not commit a reopen when the run changes during author verification", async () => {
    const r = approvalSetup();
    r.deps.approvals.authorActor = () => {
      r.setRun({ ...r.getRun(), version: 1 });
      return Promise.resolve("developer");
    };
    expect(await recordReworkEvent(r.deps, reopen)).toEqual({ ok: false, reason: "STALE_VERSION" });
  });
  it("derives Architect approval validity from the approved request", async () => {
    const r = approvalSetup();
    r.deps.runs.get = () => ({
      ...r.getRun(),
      status: "running",
      rework: { ...INITIAL_REWORK_STATE, phase: "architect", failedCycles: 2 },
    });
    expect(
      await recordReworkEvent(r.deps, {
        runId: "run",
        event: {
          type: "architect_solution_accepted",
          interventionId: "arch",
          changesBusinessOrCost: true,
          poDecisionId: "decision",
        },
      }),
    ).toMatchObject({ ok: true, action: "retry", state: { phase: "assisted" } });
  });
});

it.each([
  { type: "cycle_failed", cycleId: "c", kind: "quality" },
  { type: "gate_passed" },
  {
    type: "architect_solution_accepted",
    interventionId: "arch",
    changesBusinessOrCost: false,
    approvalValid: true,
  },
])("public rework refuses internal or caller-attested event %j", async (event) => {
  const r = setup({ ...INITIAL_REWORK_STATE, phase: "architect", failedCycles: 2 });
  expect(await recordReworkDecision(r.deps, { runId: "run", event })).toEqual({
    ok: false,
    reason: "INVALID_INPUT",
  });
  expect(r.commit).not.toHaveBeenCalled();
});

it("does not accept a caller approval flag for a scope-changing Architect solution", async () => {
  const r = setup({ ...INITIAL_REWORK_STATE, phase: "architect", failedCycles: 2 });
  expect(
    await recordReworkEvent(r.deps, {
      runId: "run",
      event: {
        type: "architect_solution_accepted",
        interventionId: "arch",
        changesBusinessOrCost: true,
        approvalValid: true,
      },
    }),
  ).toEqual({ ok: false, reason: "APPROVAL_REQUIRED" });
});

it("allows a runtime-authenticated TTY approval without a GitHub allowlist", async () => {
  if (approved.decision === undefined) throw new Error("missing fixture decision");
  const r = approvalSetup({
    ...approved,
    decision: { ...approved.decision, source: "po-cli", actor: "local-po" },
  });
  r.deps.approvals.allowedGitHubActors = [];
  expect(await recordReworkEvent(r.deps, reopen)).toMatchObject({ ok: true, action: "retry" });
});

it("refuses a record without an authenticated decision", async () => {
  const pending = { ...approved };
  delete pending.decision;
  const r = approvalSetup(pending);
  expect(await recordReworkEvent(r.deps, reopen)).toEqual({
    ok: false,
    reason: "SOURCE_NOT_AUTHENTICATED",
  });
});
