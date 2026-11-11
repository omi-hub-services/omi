import { describe, expect, it } from "vitest";
import { dispatchStep } from "../../src/application/use-cases/runs/dispatch-step.ts";
import { recordStepResult } from "../../src/application/use-cases/runs/record-step-result.ts";
import {
  BASE,
  dispatchInput,
  HEAD,
  rig,
  type Rig,
} from "../unit/application/use-cases/runs/run-fakes.ts";

/** A fake worker: reads the prompt it was given and publishes what it claims to have done. */
function runWorker(r: Rig, attemptId: string, mode: "good" | "silent") {
  const request = r.executor.started.find((s) => s.attemptId === attemptId);
  if (request === undefined) throw new Error("worker was never started");
  if (mode === "silent") return undefined;
  const root = `attempts/${attemptId}`;
  const artifact = r.artifacts.publish(`${root}/reports/implementation.md`, `work of ${attemptId}`);
  const evidence = `${root}/reports/unit-tests.txt`;
  const evidenceArtifact = r.artifacts.publish(evidence, "all green");
  return {
    schemaVersion: 1,
    runId: "run-1",
    stepId: "implement",
    attemptId,
    status: "succeeded",
    summary: "Implemented.",
    artifacts: [artifact, evidenceArtifact],
    revision: { headSha: HEAD, baseSha: BASE },
    checks: [{ id: "unit-tests", evidenceRef: evidence }],
    findings: [],
  };
}

describe("dispatch a step, run a fake worker, record its result", () => {
  it("takes a step from ready to succeeded only through a verified result", async () => {
    const r = rig();
    const dispatch = await dispatchStep(r.deps, dispatchInput());
    if (!dispatch.ok) throw new Error(dispatch.reason);
    expect(r.steps.rows.get("step-1")?.status).toBe("running");

    // The worker got the resolver's set and nothing else.
    const prompt = r.executor.started[0]?.prompt ?? "";
    expect(prompt).toContain("project-baseline");
    expect(prompt).not.toContain("debugging");

    const execution = await r.executor.collectResult(dispatch.handle);
    const result = runWorker(r, dispatch.attempt.id, "good");
    expect(recordStepResult(r.deps, { attemptId: dispatch.attempt.id, execution, result })).toEqual(
      {
        ok: true,
        stepStatus: "succeeded",
        attemptStatus: "succeeded",
      },
    );
    expect(r.steps.rows.get("step-1")?.status).toBe("succeeded");
    expect(r.workspaces.released).toEqual([1]);
    expect(r.unitOfWork.commits.map((c) => c.event.kind)).toEqual([
      "step.dispatched",
      "step.succeeded",
    ]);
  });

  it("fails a step whose worker exited 0 without a result, then a retry succeeds and a late event from the first attempt is ignored", async () => {
    const r = rig();
    const first = await dispatchStep(r.deps, dispatchInput());
    if (!first.ok) throw new Error(first.reason);
    const firstExecution = await r.executor.collectResult(first.handle);
    expect(firstExecution).toMatchObject({ outcome: "succeeded", exitCode: 0 });
    runWorker(r, first.attempt.id, "silent");

    expect(
      recordStepResult(r.deps, { attemptId: first.attempt.id, execution: firstExecution }),
    ).toMatchObject({
      ok: true,
      stepStatus: "failed",
      failure: "RESULT_MISSING",
    });

    // A retry (authorised elsewhere) is a new attempt on the same step.
    const row = r.steps.rows.get("step-1");
    if (row === undefined) throw new Error("step vanished");
    r.steps.rows.set("step-1", { ...row, status: "ready", version: row.version + 1 });
    const second = await dispatchStep(r.deps, dispatchInput());
    if (!second.ok) throw new Error(second.reason);
    expect(second.attempt.attemptNumber).toBe(2);
    const secondExecution = await r.executor.collectResult(second.handle);
    const secondResult = runWorker(r, second.attempt.id, "good");
    expect(
      recordStepResult(r.deps, {
        attemptId: second.attempt.id,
        execution: secondExecution,
        result: secondResult,
      }),
    ).toMatchObject({ ok: true, stepStatus: "succeeded" });

    // The first worker's late report cannot reopen or overwrite anything.
    const commits = r.unitOfWork.commits.length;
    expect(
      recordStepResult(r.deps, { attemptId: first.attempt.id, execution: firstExecution }),
    ).toEqual({
      ok: false,
      reason: "STALE_ATTEMPT",
    });
    expect(r.steps.rows.get("step-1")?.status).toBe("succeeded");
    expect(r.unitOfWork.commits).toHaveLength(commits);
  });

  it("refuses to dispatch a step whose role references something unknown", async () => {
    const r = rig();
    const refused = await dispatchStep(r.deps, dispatchInput({ stepSkills: ["not-in-catalog"] }));
    expect(refused).toMatchObject({ ok: false, reason: "UNKNOWN_REFERENCE" });
    expect(r.executor.started).toHaveLength(0);
    expect(r.steps.rows.get("step-1")?.status).toBe("ready");
  });
});
