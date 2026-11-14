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
  const evidenceArtifact = r.artifacts.publish(evidence, "ok");
  const skillEvidence = r.artifacts.publish(`${root}/reports/skill-tdd.md`, "wrote the test first");
  return {
    schemaVersion: 1,
    runId: "run-1",
    stepId: "implement",
    attemptId,
    status: "succeeded",
    summary: "Implemented.",
    artifacts: [artifact, evidenceArtifact, skillEvidence],
    revision: { headSha: HEAD, baseSha: BASE },
    checks: [{ id: "unit-tests", evidenceRef: evidence }],
    skillsApplied: [{ id: "tdd", evidenceRef: skillEvidence.path }],
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

    it("hashes an artifact the worker declared by path only and records the real hash", async () => {
      const r = rig();
      const { attempt, handle } = await started(r);
      const good = goodResult(r, attempt.id);
      const bare = good.artifacts.map(({ path }) => ({ path }));
      const result = await record(r, attempt.id, handle, { ...good, artifacts: bare });
      expect(result).toMatchObject({ stepStatus: "succeeded" });
      const payload = JSON.parse(r.unitOfWork.commits.at(-1)?.event.payload ?? "{}") as {
        result: { artifacts: unknown[] };
      };
      expect(payload.result.artifacts).toEqual(good.artifacts);
    });

    it("still refuses a path-only artifact that is missing or outside the root", async () => {
      const missing = await failureOf((r, id) =>
        goodResult(r, id, { artifacts: [{ path: `attempts/${id}/missing.md` }] }),
      );
      expect(missing).toMatchObject({ failure: "ARTIFACT_INVALID" });
      const outside = await failureOf((r, id) => {
        r.artifacts.publish("attempts/someone-else/x.md", "x");
        return goodResult(r, id, { artifacts: [{ path: "attempts/someone-else/x.md" }] });
      });
      expect(outside).toMatchObject({ failure: "PATH_OUTSIDE_ROOT" });
    });

    it("records the runtime's own revision when a write worker has no shell to report one", async () => {
      for (const revision of [undefined, { headSha: "unavailable", baseSha: "unavailable" }]) {
        const r = rig();
        const { attempt, handle } = await started(r);
        const claim = { ...goodResult(r, attempt.id), revision };
        const result = await record(r, attempt.id, handle, claim);
        expect(result).toMatchObject({ stepStatus: "succeeded" });
        const payload = JSON.parse(r.unitOfWork.commits.at(-1)?.event.payload ?? "{}") as {
          result: { revision: { headSha: string; baseSha: string } };
        };
        expect(payload.result.revision).toEqual({ headSha: HEAD, baseSha: BASE });
      }
    });

    it("refuses a well-formed base claim that differs from the runtime's merge-base", async () => {
      const r = rig();
      const { attempt, handle } = await started(r);
      const revision = { headSha: HEAD, baseSha: "d".repeat(40) };
      const result = await record(r, attempt.id, handle, {
        ...goodResult(r, attempt.id),
        revision,
      });
      expect(result).toEqual({ ok: false, reason: "STALE_REVISION" });
    });

    it("rejects a result missing a check the step gate requires", async () => {
      const result = await failureOf((r, id) => goodResult(r, id, { checks: [] }));
      expect(result).toMatchObject({ failure: "REQUIRED_CHECK_MISSING" });
    });

    it("rejects a result that reports none of the skills the attempt was given", async () => {
      const result = await failureOf((r, id) => goodResult(r, id, { skillsApplied: [] }));
      expect(result).toMatchObject({ failure: "SKILL_EVIDENCE_MISSING" });
    });

    it("rejects a skill whose evidence is not a verified, non-empty artifact", async () => {
      const root = (id: string) => `attempts/${id}`;
      expect(
        await failureOf((r, id) =>
          goodResult(r, id, {
            skillsApplied: [{ id: "tdd", evidenceRef: `${root(id)}/reports/ghost.md` }],
          }),
        ),
      ).toMatchObject({ failure: "ARTIFACT_INVALID" });
      expect(
        await failureOf((r, id) => {
          const empty = r.artifacts.publish(`${root(id)}/reports/skill-tdd-empty.md`, "");
          const good = goodResult(r, id, {
            skillsApplied: [{ id: "tdd", evidenceRef: empty.path }],
          });
          return { ...good, artifacts: [...good.artifacts, empty] };
        }),
      ).toMatchObject({ failure: "ARTIFACT_INVALID" });
      expect(
        await failureOf((r, id) =>
          goodResult(r, id, { skillsApplied: [{ id: "tdd", evidenceRef: "attempts/other/x.md" }] }),
        ),
      ).toMatchObject({ failure: "PATH_OUTSIDE_ROOT" });
    });

    it("rejects a skill the attempt was not given", async () => {
      const result = await failureOf((r, id) => {
        const good = goodResult(r, id);
        return {
          ...good,
          skillsApplied: [
            ...good.skillsApplied,
            { id: "debugging", evidenceRef: good.checks[0]?.evidenceRef },
          ],
        };
      });
      expect(result).toMatchObject({ failure: "SKILL_NOT_ASSIGNED" });
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

describe("checks the runtime ran itself", () => {
  const RUNTIME_CHECKS = { has: (id: string) => id === "unit-tests" };

  function checkRun(r: Rig, attemptId: string, overrides: Record<string, unknown> = {}) {
    const evidence = r.artifacts.publish(
      `attempts/${attemptId}/checks/unit-tests.json`,
      '{"log":"ran by the runtime"}',
    );
    return {
      checkId: "unit-tests",
      status: "passed",
      exitCode: 0,
      command: ["npm", "test"],
      startedAt: "2026-11-11T00:00:00.000Z",
      endedAt: "2026-11-11T00:00:05.000Z",
      revision: HEAD,
      evidence,
      ...overrides,
    };
  }

  /** The worker lists no checks at all: only the runtime's run can satisfy the gate. */
  async function recordWith(
    mutate: (r: Rig, attemptId: string) => Record<string, unknown>[] | undefined,
    result: (r: Rig, attemptId: string) => unknown = (r, id) => goodResult(r, id, { checks: [] }),
  ) {
    const r = rig();
    const { attempt, handle } = await started(r);
    const execution = await r.executor.collectResult(handle);
    const checkRuns = mutate(r, attempt.id);
    const outcome = recordStepResult(
      { ...r.deps, checks: RUNTIME_CHECKS },
      {
        attemptId: attempt.id,
        execution,
        result: result(r, attempt.id),
        ...(checkRuns === undefined ? {} : { checkRuns }),
      },
    );
    return { r, outcome, attempt };
  }

  it("accepts the step when the runtime's check passed on the revision the worker reported", async () => {
    const { r, outcome, attempt } = await recordWith((r, id) => [checkRun(r, id)]);
    expect(outcome).toEqual({ ok: true, stepStatus: "succeeded", attemptStatus: "succeeded" });
    const event = r.unitOfWork.commits.at(-1)?.event;
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({
      attemptId: attempt.id,
      checkRuns: [{ checkId: "unit-tests", status: "passed", revision: HEAD }],
    });
  });

  it("does not accept a worker's claim that it ran the check", async () => {
    const { r, outcome } = await recordWith(
      () => undefined,
      (r, id) => goodResult(r, id), // reports "unit-tests" with real evidence
    );
    expect(outcome).toMatchObject({ ok: true, stepStatus: "failed", failure: "CHECK_NOT_RUN" });
    expect(stepStatus(r)).toBe("failed");
  });

  it("fails the step when the runtime's check failed, whatever the worker claims", async () => {
    const { r, outcome, attempt } = await recordWith(
      (r, id) => [checkRun(r, id, { status: "failed", exitCode: 1 })],
      (r, id) => goodResult(r, id),
    );
    expect(outcome).toMatchObject({ ok: true, stepStatus: "failed", failure: "CHECK_FAILED" });
    expect(r.attempts.get(attempt.id)?.status).toBe("failed");
  });

  it("fails the step when the runtime's check timed out", async () => {
    const { outcome } = await recordWith((r, id) => [
      checkRun(r, id, { status: "timed-out", exitCode: null }),
    ]);
    expect(outcome).toMatchObject({ ok: true, stepStatus: "failed", failure: "CHECK_TIMED_OUT" });
  });

  it("fails the step when the check ran on another revision than the worker reported", async () => {
    const { outcome } = await recordWith((r, id) => [
      checkRun(r, id, { revision: "d".repeat(40) }),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      stepStatus: "failed",
      failure: "CHECK_REVISION_MISMATCH",
    });
  });

  it("fails the step when a required runtime check has no run among several", async () => {
    const r = rig();
    const input = dispatchInput();
    const { attempt, handle } = await started(r, {
      ...input,
      requiredChecks: ["unit-tests", "lint"],
    });
    const execution = await r.executor.collectResult(handle);
    const outcome = recordStepResult(
      { ...r.deps, checks: { has: () => true } },
      {
        attemptId: attempt.id,
        execution,
        result: goodResult(r, attempt.id, { checks: [] }),
        checkRuns: [checkRun(r, attempt.id)],
      },
    );
    expect(outcome).toMatchObject({ stepStatus: "failed", failure: "CHECK_NOT_RUN" });
  });

  it("rejects check evidence that is not the bytes the runtime stored", async () => {
    const { outcome } = await recordWith((r, id) => [
      checkRun(r, id, {
        evidence: { path: `attempts/${id}/checks/unit-tests.json`, sha256: "0".repeat(64) },
      }),
    ]);
    // The stored file exists with another hash: the reference is not trusted.
    expect(outcome).toMatchObject({ stepStatus: "failed", failure: "ARTIFACT_HASH_MISMATCH" });
  });

  it("rejects check evidence outside the attempt's artifact root", async () => {
    const { outcome } = await recordWith((r) => [
      {
        ...checkRun(r, "x"),
        evidence: r.artifacts.publish("attempts/someone-else/checks/unit-tests.json", "{}"),
      },
    ]);
    expect(outcome).toMatchObject({ stepStatus: "failed", failure: "PATH_OUTSIDE_ROOT" });
  });

  it("still takes an id the runtime does not run from the worker's evidence", async () => {
    const r = rig();
    const { attempt, handle } = await started(r); // requires "unit-tests"; runtime runs nothing
    const execution = await r.executor.collectResult(handle);
    const outcome = recordStepResult(
      { ...r.deps, checks: { has: () => false } },
      { attemptId: attempt.id, execution, result: goodResult(r, attempt.id) },
    );
    expect(outcome).toMatchObject({ stepStatus: "succeeded" });
  });
});
