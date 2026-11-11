import { describe, expect, it } from "vitest";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { recordStepResult } from "../../../../../src/application/use-cases/runs/record-step-result.ts";
import { dispatchInput, HEAD, BASE, rig, type Rig } from "./run-fakes.ts";

async function started(r: Rig, input: Record<string, unknown> = dispatchInput()) {
  const dispatch = await dispatchStep(r.deps, input);
  if (!dispatch.ok) throw new Error(`refused: ${dispatch.reason}`);
  return { attempt: dispatch.attempt, handle: dispatch.handle };
}

/** A well-formed claim whose artifact the runtime really holds. */
function goodResult(r: Rig, attemptId: string, overrides: Record<string, unknown> = {}) {
  const root = `attempts/${attemptId}`;
  const artifact = r.artifacts.publish(`${root}/reports/implementation.md`, "done");
  const evidence = `${root}/reports/unit-tests.txt`;
  r.artifacts.publish(evidence, "ok");
  return {
    schemaVersion: 1,
    runId: "run-1",
    stepId: "implement",
    attemptId,
    status: "succeeded",
    summary: "Implemented.",
    artifacts: [artifact],
    revision: { headSha: HEAD, baseSha: BASE },
    checks: [{ id: "unit-tests", evidenceRef: evidence }],
    findings: [],
    ...overrides,
  };
}

async function record(
  r: Rig,
  attemptId: string,
  handle: Parameters<Rig["executor"]["collectResult"]>[0],
  result?: unknown,
) {
  const execution = await r.executor.collectResult(handle);
  return recordStepResult(r.deps, {
    attemptId,
    execution,
    ...(result === undefined ? {} : { result }),
  });
}

const stepStatus = (r: Rig) => r.steps.rows.get("step-1")?.status;

describe("recordStepResult", () => {
  it("accepts a verified result: step and attempt succeed and the writer is released", async () => {
    const r = rig();
    const { attempt, handle } = await started(r);
    const result = await record(r, attempt.id, handle, goodResult(r, attempt.id));

    expect(result).toEqual({ ok: true, stepStatus: "succeeded", attemptStatus: "succeeded" });
    expect(stepStatus(r)).toBe("succeeded");
    expect(r.attempts.get(attempt.id)?.status).toBe("succeeded");
    expect(r.workspaces.released).toEqual([1]);
    const event = r.unitOfWork.commits.at(-1)?.event;
    expect(event?.kind).toBe("step.succeeded");
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({
      attemptId: attempt.id,
      exitCode: 0,
    });
  });

  describe("exit code 0 is not Done", () => {
    it("fails the step when the process exited 0 with no structured result", async () => {
      const r = rig();
      const { attempt, handle } = await started(r);
      const execution = await r.executor.collectResult(handle);
      expect(execution.exitCode).toBe(0);
      const result = recordStepResult(r.deps, { attemptId: attempt.id, execution });
      expect(result).toEqual({
        ok: true,
        stepStatus: "failed",
        attemptStatus: "failed",
        failure: "RESULT_MISSING",
      });
      expect(stepStatus(r)).toBe("failed");
    });

    it("fails the step when the result does not match the schema", async () => {
      const r = rig();
      const { attempt, handle } = await started(r);
      const result = await record(r, attempt.id, handle, {
        status: "succeeded",
        summary: "trust me",
      });
      expect(result).toMatchObject({ ok: true, stepStatus: "failed", failure: "RESULT_INVALID" });
    });

    it("fails the step when the process outcome is not succeeded, whatever the result claims", async () => {
      const r = rig();
      const { attempt, handle } = await started(r);
      r.executor.outcome = "timed-out";
      r.executor.exitCode = 0;
      const result = await record(r, attempt.id, handle, goodResult(r, attempt.id));
      expect(result).toMatchObject({ ok: true, stepStatus: "failed", failure: "EXECUTION_FAILED" });
    });

    it("fails the step when the worker reports failure or blocked", async () => {
      for (const status of ["failed", "blocked"]) {
        const r = rig();
        const { attempt, handle } = await started(r);
        const result = await record(r, attempt.id, handle, goodResult(r, attempt.id, { status }));
        expect(result).toMatchObject({ failure: "WORKER_REPORTED_FAILURE", stepStatus: "failed" });
      }
    });
  });

  describe("verification before acceptance", () => {
    async function failureOf(mutate: (r: Rig, attemptId: string) => Record<string, unknown>) {
      const r = rig();
      const { attempt, handle } = await started(r);
      const result = await record(r, attempt.id, handle, mutate(r, attempt.id));
      expect(stepStatus(r)).toBe("failed");
      return result;
    }

    it("rejects a result for another run, step or attempt", async () => {
      for (const wrong of [{ runId: "run-2" }, { stepId: "review" }, { attemptId: "other" }]) {
        const result = await failureOf((r, id) => goodResult(r, id, wrong));
        expect(result).toMatchObject({ failure: "RESULT_MISMATCH" });
      }
    });

    it("rejects a path outside the attempt's artifact root", async () => {
      const result = await failureOf((r, id) => {
        const outside = r.artifacts.publish("attempts/someone-else/x.md", "x");
        return goodResult(r, id, { artifacts: [outside] });
      });
      expect(result).toMatchObject({ failure: "PATH_OUTSIDE_ROOT" });
    });

    it("rejects an evidence reference outside the root", async () => {
      const result = await failureOf((r, id) =>
        goodResult(r, id, { checks: [{ id: "unit-tests", evidenceRef: "elsewhere/log.txt" }] }),
      );
      expect(result).toMatchObject({ failure: "PATH_OUTSIDE_ROOT" });
    });

    it("rejects traversal and non-canonical paths", async () => {
      const traversal = await failureOf((r, id) =>
        goodResult(r, id, {
          artifacts: [{ path: `attempts/${id}/../other/x.md`, sha256: "0".repeat(64) }],
        }),
      );
      expect(traversal).toMatchObject({ failure: "RESULT_INVALID" });
      const aliased = await failureOf((r, id) =>
        goodResult(r, id, {
          artifacts: [{ path: `attempts/${id}//x.md`, sha256: "0".repeat(64) }],
        }),
      );
      expect(aliased).toMatchObject({ failure: "PATH_OUTSIDE_ROOT" });
    });

    it("rejects an artifact that does not exist", async () => {
      const result = await failureOf((r, id) =>
        goodResult(r, id, {
          artifacts: [{ path: `attempts/${id}/missing.md`, sha256: "1".repeat(64) }],
        }),
      );
      expect(result).toMatchObject({ failure: "ARTIFACT_INVALID" });
    });

    it("rejects an artifact whose hash differs from the claim", async () => {
      const result = await failureOf((r, id) => {
        const good = goodResult(r, id);
        const [artifact] = good.artifacts;
        return { ...good, artifacts: [{ path: artifact?.path, sha256: "2".repeat(64) }] };
      });
      expect(result).toMatchObject({ failure: "ARTIFACT_HASH_MISMATCH" });
    });

    it("rejects a write attempt that reports no revision", async () => {
      const result = await failureOf((r, id) => ({ ...goodResult(r, id), revision: undefined }));
      expect(result).toMatchObject({ failure: "REVISION_MISSING" });
    });

    it("rejects a result missing a check the step gate requires", async () => {
      const result = await failureOf((r, id) => goodResult(r, id, { checks: [] }));
      expect(result).toMatchObject({ failure: "REQUIRED_CHECK_MISSING" });
    });

    it("accepts a read-only attempt without a revision", async () => {
      const r = rig();
      const input = dispatchInput();
      const { attempt, handle } = await started(r, {
        ...input,
        requiredChecks: [],
        execution: { ...(input.execution as object), access: "read-only" },
      });
      const good = { ...goodResult(r, attempt.id), revision: undefined, checks: [] };
      expect(await record(r, attempt.id, handle, good)).toMatchObject({ stepStatus: "succeeded" });
    });
  });

  describe("stale events never overwrite newer state", () => {
    it("refuses a result for a superseded attempt and writes nothing", async () => {
      const r = rig();
      const first = await started(r);
      const firstResult = goodResult(r, first.attempt.id);
      const firstExecution = await r.executor.collectResult(first.handle);
      // The first attempt was abandoned; a retry runs as a new attempt.
      r.steps.rows.set("step-1", { ...r.steps.must("step-1"), status: "ready" });
      const second = await started(r);
      const commitsBefore = r.unitOfWork.commits.length;
      const stepBefore = r.steps.rows.get("step-1");

      const late = recordStepResult(r.deps, {
        attemptId: first.attempt.id,
        execution: firstExecution,
        result: firstResult,
      });

      expect(late).toEqual({ ok: false, reason: "STALE_ATTEMPT" });
      expect(r.unitOfWork.commits).toHaveLength(commitsBefore);
      expect(r.steps.rows.get("step-1")).toEqual(stepBefore);
      expect(r.attempts.get(first.attempt.id)?.status).toBe("running");
      expect(r.attempts.get(second.attempt.id)?.status).toBe("running");
    });

    it("refuses a result built on an older revision and writes nothing", async () => {
      const r = rig();
      const { attempt, handle } = await started(r);
      const commitsBefore = r.unitOfWork.commits.length;
      r.workspaces.headSha = "c".repeat(40); // the worktree moved on
      const result = await record(r, attempt.id, handle, goodResult(r, attempt.id));
      expect(result).toEqual({ ok: false, reason: "STALE_REVISION" });
      expect(r.unitOfWork.commits).toHaveLength(commitsBefore);
      expect(stepStatus(r)).toBe("running");
      expect(r.attempts.get(attempt.id)?.status).toBe("running");
    });

    it("does not let a repeated event overwrite a recorded outcome", async () => {
      const r = rig();
      const { attempt, handle } = await started(r);
      await record(r, attempt.id, handle, goodResult(r, attempt.id));
      const commitsBefore = r.unitOfWork.commits.length;
      const execution = await r.executor.collectResult(handle);
      const again = recordStepResult(r.deps, { attemptId: attempt.id, execution });
      expect(again).toEqual({ ok: false, reason: "ATTEMPT_NOT_RUNNING" });
      expect(stepStatus(r)).toBe("succeeded");
      expect(r.unitOfWork.commits).toHaveLength(commitsBefore);
    });

    it("refuses when the step row changed during verification (version) or the lease is stale", async () => {
      const r = rig();
      const { attempt, handle } = await started(r);
      const result = goodResult(r, attempt.id);
      const execution = await r.executor.collectResult(handle);
      const old = { get: () => ({ ...r.steps.must("step-1"), version: 1 }) };
      expect(
        recordStepResult({ ...r.deps, steps: old }, { attemptId: attempt.id, execution, result }),
      ).toEqual({
        ok: false,
        reason: "STATE_REJECTED",
        detail: "STALE_VERSION",
      });
      r.workspaces.leases.set("worktree:omi-017", {
        resourceKey: "worktree:omi-017",
        owner: "worker-2",
        generation: 9,
        acquiredAt: "2026-11-11T00:00:00.000Z",
        expiresAt: "2026-11-11T01:00:00.000Z",
      });
      expect(recordStepResult(r.deps, { attemptId: attempt.id, execution, result })).toEqual({
        ok: false,
        reason: "STATE_REJECTED",
        detail: "STALE_LEASE",
      });
      expect(stepStatus(r)).toBe("running");
      expect(r.attempts.get(attempt.id)?.status).toBe("running");
    });
  });

  it("refuses unknown attempts, malformed input and executions of another attempt", async () => {
    const r = rig();
    const { attempt, handle } = await started(r);
    const execution = await r.executor.collectResult(handle);
    expect(recordStepResult(r.deps, { attemptId: "ghost", execution })).toEqual({
      ok: false,
      reason: "ATTEMPT_NOT_FOUND",
    });
    expect(recordStepResult(r.deps, { attemptId: attempt.id })).toEqual({
      ok: false,
      reason: "INVALID_INPUT",
    });
    expect(
      recordStepResult(r.deps, {
        attemptId: attempt.id,
        execution: { ...execution, attemptId: "x" },
      }),
    ).toEqual({ ok: false, reason: "EXECUTION_MISMATCH" });
    expect(stepStatus(r)).toBe("running");
  });
});
