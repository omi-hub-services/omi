import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { workflowSchema } from "../../../../src/application/contracts/workflow.ts";
import type { CheckRunRecord } from "../../../../src/application/contracts/check-run.ts";
import type { ExecutionResult } from "../../../../src/application/contracts/agent-execution.ts";
import type {
  CheckRunner,
  CheckRunRequest,
} from "../../../../src/application/ports/check-runner.ts";
import { completeRunAttempt } from "../../../../src/application/services/complete-run-attempt.ts";
import { dispatchStep } from "../../../../src/application/use-cases/runs/dispatch-step.ts";
import type { RecordReworkEventDependencies } from "../../../../src/application/use-cases/runs/record-rework-event.ts";
import { INITIAL_REWORK_STATE } from "../../../../src/domain/runs/rework-policy.ts";
import {
  BASE,
  dispatchInput,
  HEAD,
  rig,
  skillEvidence,
  type Rig,
} from "../use-cases/runs/run-fakes.ts";

type Status = CheckRunRecord["status"];

function setup(options: { check?: Status; checkRevision?: string; has?: boolean } = {}) {
  const r = rig();
  const run = vi.fn<CheckRunner["run"]>((request: CheckRunRequest) => {
    const evidence = r.artifacts.publish(
      `${request.artifactRoot}/checks/${request.checkId}.json`,
      '{"log":"output of the check"}',
    );
    const status = options.check ?? "passed";
    return Promise.resolve({
      checkId: request.checkId,
      status,
      exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
      command: ["npm", "test"],
      startedAt: "2026-11-11T00:00:00.000Z",
      endedAt: "2026-11-11T00:00:05.000Z",
      revision: options.checkRevision ?? HEAD,
      evidence,
    });
  });
  const checks: CheckRunner = { has: () => options.has ?? true, run };
  const reworkCommits: { kind: string }[] = [];
  const rework: RecordReworkEventDependencies = {
    runs: {
      get: () => ({
        id: "run-1",
        taskId: "task",
        status: "running",
        version: 0,
        rework: INITIAL_REWORK_STATE,
      }),
    },
    session: {
      lease: {
        resourceKey: "project-owner",
        owner: "owner",
        generation: 1,
        acquiredAt: "t",
        expiresAt: "t",
      },
      commit: (change) => {
        reworkCommits.push({ kind: change.event.kind });
        return { ok: true, newVersion: 1, eventSequence: 1 };
      },
      renew: () => true,
      record: () => {},
      release: () => {},
    },
    checkpoint: () => ({ ok: true, checkpointId: "checkpoint" }),
    nextId: () => "event",
  };
  const sessionEvents: string[] = [];
  const deps = {
    ...r.deps,
    runs: { get: () => undefined, listSteps: () => [...r.steps.rows.values()] },
    plans: { forRun: () => undefined },
    workflows: { byId: () => undefined, byHash: () => undefined },
    session: {
      commit: (change: { event: { kind: string } }) => {
        sessionEvents.push(change.event.kind);
        return { ok: true as const, newVersion: 1, eventSequence: 1 };
      },
    },
    checks,
    rework,
  };
  return { r, run, deps, reworkCommits, sessionEvents };
}

/** The worker claims success and lists no checks: the gate cannot lean on its words. */
async function finish(
  s: ReturnType<typeof setup>,
  report: (
    r: Rig,
    attemptId: string,
    skills: ReturnType<typeof skillEvidence>,
  ) => unknown = () => ({}),
  execution: Partial<ExecutionResult> = {},
  quality = false,
  wrap?: (json: string) => string,
  requiredChecks: string[] = ["unit-tests"],
) {
  const input = dispatchInput({
    requiredChecks,
    ...(quality
      ? {
          quality: {
            policy: "task-default",
            step: "review",
            steps: ["verify", "review"],
            round: 1,
          },
        }
      : {}),
  });
  const dispatched = await dispatchStep(s.deps, input);
  if (!dispatched.ok) throw new Error(dispatched.reason);
  const attempt = dispatched.attempt;
  const skills = skillEvidence(attempt, (path, text) => s.r.artifacts.publish(path, text));
  const result = {
    schemaVersion: 1,
    runId: "run-1",
    stepId: "implement",
    attemptId: attempt.id,
    status: "succeeded",
    summary: "Implemented.",
    artifacts: skills.artifacts,
    revision: { headSha: HEAD, baseSha: BASE },
    checks: [],
    skillsApplied: skills.skillsApplied,
    findings: [],
    ...(report(s.r, attempt.id, skills) as object),
  };
  const collected = await s.r.executor.collectResult(dispatched.handle);
  s.r.executor.collectResult = () =>
    Promise.resolve({
      ...collected,
      ...execution,
      finalMessage:
        wrap?.(JSON.stringify(result)) ?? execution.finalMessage ?? JSON.stringify(result),
    });
  await completeRunAttempt(s.deps, attempt.id, dispatched.handle, "run-1", {});
  return attempt;
}

const stepStatus = (s: ReturnType<typeof setup>) => s.r.steps.rows.get("step-1")?.status;

describe("completeRunAttempt runs the step's required checks itself", () => {
  it("runs the configured check in the attempt's worktree and accepts the step when it passes", async () => {
    const s = setup();
    const attempt = await finish(s);

    expect(s.run).toHaveBeenCalledTimes(1);
    expect(s.run).toHaveBeenCalledWith({
      attemptId: attempt.id,
      checkId: "unit-tests",
      workspacePath: attempt.workspace.path,
      artifactRoot: attempt.artifactRoot,
    });
    expect(stepStatus(s)).toBe("succeeded");
    expect(s.reworkCommits).toEqual([]);
  });

  it("fails the step and hands it to the rework controller when the check fails", async () => {
    const s = setup({ check: "failed" });
    await finish(s);
    expect(stepStatus(s)).toBe("failed");
    const failed = s.r.unitOfWork.commits.at(-1)?.event;
    expect(JSON.parse(failed?.payload ?? "{}")).toMatchObject({ failure: "CHECK_FAILED" });
    // The existing controller counted a quality failure and authorized a retry of the step.
    expect(s.reworkCommits.length).toBeGreaterThan(0);
    expect(s.sessionEvents).toContain("step.retry_authorized");
  });

  it("keeps a bounded finding with the failed check's id, exit code, log tail and artifact path for the next attempt", async () => {
    const remembered = new Map<string, unknown[]>();
    const s = setup({ check: "failed" });
    const findings = {
      remember: (stepRunId: string, entries: unknown[]) => remembered.set(stepRunId, entries),
      recall: (stepRunId: string) => remembered.get(stepRunId) ?? [],
    };
    Object.assign(s.deps, { findings });
    const attempt = await finish(s);
    const [finding] = remembered.get(attempt.stepRunId) as {
      id: string;
      severity: string;
      message: string;
      location: string;
    }[];
    expect(finding?.id).toBe("check-unit-tests");
    expect(finding?.message).toContain("unit-tests");
    expect(finding?.message).toContain("exit code 1");
    expect(finding?.message).toContain("output of the check");
    expect(finding?.message.length).toBeLessThanOrEqual(2000);
    expect(finding?.location).toBe(`${attempt.artifactRoot}/checks/unit-tests.json`);
  });

  describe("for a shell-less implement worker under the installed templates", () => {
    // The worker ran nothing and says so: succeeded, the AC unverified, no checks listed.
    const unverified = () => ({
      summary: "Implemented. AC-1: not verified, no shell to run npm test.",
      checks: [],
    });
    const required = (id: string) =>
      workflowSchema
        .parse(parse(readFileSync(`templates/project/workflows/${id}.yaml`, "utf8")))
        .steps.find((step) => step.id === "implement")?.required_checks ?? [];

    it.each(["feature", "bugfix", "refactor"])(
      "accepts the %s implement step when the runtime's project-check passes",
      async (id) => {
        const s = setup();
        const attempt = await finish(s, unverified, {}, false, undefined, required(id));
        expect(s.run).toHaveBeenCalledWith(expect.objectContaining({ checkId: "project-check" }));
        expect(attempt.requiredChecks).toEqual(["project-check"]);
        expect(stepStatus(s)).toBe("succeeded");
      },
    );

    it.each(["feature", "bugfix", "refactor"])(
      "fails the %s implement step with CHECK_FAILED when project-check fails",
      async (id) => {
        const s = setup({ check: "failed" });
        await finish(s, unverified, {}, false, undefined, required(id));
        expect(stepStatus(s)).toBe("failed");
        const failed = s.r.unitOfWork.commits.at(-1)?.event;
        expect(JSON.parse(failed?.payload ?? "{}")).toMatchObject({ failure: "CHECK_FAILED" });
      },
    );
  });

  it("keeps no check finding when the check passes", async () => {
    const remembered = new Map<string, unknown[]>();
    const s = setup();
    Object.assign(s.deps, {
      findings: {
        remember: (id: string, entries: unknown[]) => remembered.set(id, entries),
        recall: () => [],
      },
    });
    const attempt = await finish(s);
    expect(remembered.get(attempt.stepRunId) ?? []).toEqual([]);
  });

  it("fails the step and hands it to the rework controller when the check times out", async () => {
    const s = setup({ check: "timed-out" });
    await finish(s);
    expect(stepStatus(s)).toBe("failed");
    const failed = s.r.unitOfWork.commits.at(-1)?.event;
    expect(JSON.parse(failed?.payload ?? "{}")).toMatchObject({ failure: "CHECK_TIMED_OUT" });
    expect(s.reworkCommits.length).toBeGreaterThan(0);
  });

  it("fails the step when the check ran on another revision than the worker reported", async () => {
    const s = setup({ checkRevision: "d".repeat(40) });
    await finish(s);
    expect(stepStatus(s)).toBe("failed");
    const failed = s.r.unitOfWork.commits.at(-1)?.event;
    expect(JSON.parse(failed?.payload ?? "{}")).toMatchObject({
      failure: "CHECK_REVISION_MISMATCH",
    });
  });

  it("runs no check when the worker reports failure", async () => {
    const s = setup();
    await finish(s, () => ({ status: "failed" }));
    expect(s.run).not.toHaveBeenCalled();
    expect(stepStatus(s)).toBe("failed");
  });

  it("runs no check when the process itself failed", async () => {
    const s = setup();
    await finish(s, () => ({}), { outcome: "timed-out" });
    expect(s.run).not.toHaveBeenCalled();
    expect(stepStatus(s)).toBe("failed");
  });

  it("runs no check on a stale revision: the worktree moved on, nothing is recorded", async () => {
    const s = setup();
    s.r.workspaces.headSha = "c".repeat(40);
    await finish(s);
    expect(s.run).not.toHaveBeenCalled();
    expect(stepStatus(s)).toBe("running");
  });

  it("runs no check the runtime has no command for", async () => {
    const s = setup({ has: false });
    await finish(s, (r, id) => {
      const evidence = r.artifacts.publish(`attempts/${id}/reports/unit-tests.txt`, "ok");
      return {
        artifacts: [evidence],
        checks: [{ id: "unit-tests", evidenceRef: evidence.path }],
      };
    });
    expect(s.run).not.toHaveBeenCalled();
  });

  it("leaves the step recoverable when the runner itself breaks, never turning it into success", async () => {
    const s = setup();
    s.run.mockRejectedValue(new Error("CHECK_UNKNOWN"));
    await finish(s);
    expect(stepStatus(s)).toBe("running");
    expect(s.sessionEvents).toContain("attempt.completion_refused");
  });
});

it("reuses the pre-dispatch quality check instead of rerunning the suite", async () => {
  const s = setup();
  await finish(s, () => ({}), {}, true);
  expect(s.run).toHaveBeenCalledTimes(1);
  expect(stepStatus(s)).toBe("succeeded");
});
it("rejects a quality verdict whose SHA differs from its supplied check", async () => {
  const s = setup({ checkRevision: "d".repeat(40) });
  await finish(s, () => ({}), {}, true);
  expect(s.run).toHaveBeenCalledTimes(1);
  expect(stepStatus(s)).toBe("failed");
  expect(JSON.parse(s.r.unitOfWork.commits.at(-1)?.event.payload ?? "{}")).toMatchObject({
    failure: "CHECK_REVISION_MISMATCH",
  });
});

describe("completeRunAttempt reads the step result out of the final message", () => {
  it("accepts prose followed by one fenced json document", async () => {
    const s = setup();
    const fence = "\u0060\u0060\u0060";
    await finish(
      s,
      () => ({}),
      {},
      false,
      (json) => `Finished.\n\n${fence}json\n${json}\n${fence}\n`,
    );
    expect(stepStatus(s)).toBe("succeeded");
  });

  it("keeps a bounded, redacted final message when no result can be read", async () => {
    const s = setup();
    const secret = "sk-" + "A1b2C3d4E5f6G7h8I9j0";
    const attempt = await finish(s, () => ({}), {
      finalMessage: `${"x ".repeat(40_000)} I could not finish. token=${secret}`,
    });
    expect(stepStatus(s)).toBe("failed");
    expect(JSON.parse(s.r.unitOfWork.commits.at(-1)?.event.payload ?? "{}")).toMatchObject({
      failure: "RESULT_MISSING",
    });
    const bytes = s.r.artifacts.files.get(`${attempt.artifactRoot}/final-message.txt`);
    const stored = new TextDecoder().decode(bytes);
    expect(stored).toContain("I could not finish");
    expect(stored).not.toContain(secret);
    expect(stored.length).toBeLessThanOrEqual(8000);
  });

  it("keeps the final message when the document fails the schema", async () => {
    const s = setup();
    const attempt = await finish(s, () => ({}), { finalMessage: '{"schemaVersion":1}' });
    expect(JSON.parse(s.r.unitOfWork.commits.at(-1)?.event.payload ?? "{}")).toMatchObject({
      failure: "RESULT_INVALID",
    });
    expect(s.r.artifacts.files.has(`${attempt.artifactRoot}/final-message.txt`)).toBe(true);
  });

  it("stores no final message when the result was read", async () => {
    const s = setup();
    const attempt = await finish(s);
    expect(s.r.artifacts.files.has(`${attempt.artifactRoot}/final-message.txt`)).toBe(false);
  });
});
