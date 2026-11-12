import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeRunAttempt } from "../../src/application/services/complete-run-attempt.ts";
import { dispatchStep } from "../../src/application/use-cases/runs/dispatch-step.ts";
import type { RecordReworkEventDependencies } from "../../src/application/use-cases/runs/record-rework-event.ts";
import { INITIAL_REWORK_STATE } from "../../src/domain/runs/rework-policy.ts";
import { createProcessCheckRunner } from "../../src/infrastructure/processes/process-check-runner.ts";
import {
  BASE,
  dispatchInput,
  rig,
  skillEvidence,
} from "../unit/application/use-cases/runs/run-fakes.ts";

const node = process.execPath;
let directory: string;
let worktree: string;
let head: string;

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "omi-check-gate-"));
  worktree = join(directory, "worktree");
  fs.mkdirSync(worktree);
  git("init", "-q");
  fs.writeFileSync(join(worktree, "a.txt"), "a");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "init");
  head = git("rev-parse", "HEAD");
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

/** A step whose worker claims a green unit-tests check; only the project command decides. */
async function runStep(command: string[], timeoutMs = 20_000) {
  const r = rig();
  r.workspaces.headSha = head;
  r.workspaces.createTask = (request) => ({
    ok: true,
    value: { taskId: request.taskId, slug: request.slug, path: worktree, branch: "task/x" },
  });
  const checks = createProcessCheckRunner({
    checks: { "unit-tests": { command, timeoutMs } },
    artifacts: r.artifacts,
    now: () => Date.now(),
    nextId: (() => {
      let n = 0;
      return () => `check-artifact-${String(++n)}`;
    })(),
  });
  const reworkEvents: string[] = [];
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
        reworkEvents.push(change.event.kind);
        return { ok: true, newVersion: 1, eventSequence: 1 };
      },
      renew: () => true,
      record: () => {},
      release: () => {},
    },
    checkpoint: () => ({ ok: true, checkpointId: "checkpoint" }),
    nextId: () => "event",
  };
  const deps = {
    ...r.deps,
    runs: { get: () => undefined, listSteps: () => [...r.steps.rows.values()] },
    plans: { forRun: () => undefined },
    workflows: { byId: () => undefined, byHash: () => undefined },
    session: {
      commit: (change: { event: { kind: string } }) => {
        reworkEvents.push(change.event.kind);
        return { ok: true as const, newVersion: 1, eventSequence: 1 };
      },
    },
    checks,
    rework,
  };

  const dispatched = await dispatchStep(deps, dispatchInput({ requiredChecks: ["unit-tests"] }));
  if (!dispatched.ok) throw new Error(dispatched.reason);
  const attempt = dispatched.attempt;
  const skills = skillEvidence(attempt, (path, text) => r.artifacts.publish(path, text));
  const claim = r.artifacts.publish(`${attempt.artifactRoot}/reports/unit-tests.txt`, "all green");
  const collected = await r.executor.collectResult(dispatched.handle);
  r.executor.collectResult = () =>
    Promise.resolve({
      ...collected,
      finalMessage: JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        stepId: "implement",
        attemptId: attempt.id,
        status: "succeeded",
        summary: "All checks green, trust me.",
        artifacts: [claim, ...skills.artifacts],
        revision: { headSha: head, baseSha: BASE },
        checks: [{ id: "unit-tests", evidenceRef: claim.path }],
        skillsApplied: skills.skillsApplied,
        findings: [],
      }),
    });
  await completeRunAttempt(deps, attempt.id, dispatched.handle, "run-1", {});

  const stored = r.artifacts.files.get(`${attempt.artifactRoot}/checks/unit-tests.json`);
  const recorded = r.unitOfWork.commits.at(-1)?.event;
  return {
    status: r.steps.rows.get("step-1")?.status,
    failure: (JSON.parse(recorded?.payload ?? "{}") as { failure?: string }).failure,
    evidence:
      stored === undefined
        ? undefined
        : (JSON.parse(new TextDecoder().decode(stored)) as {
            exitCode: number | null;
            revision: string;
            command: string[];
          }),
    reworkEvents,
  };
}

const exitsWith = (code: number) => [node, "-e", `process.exit(${String(code)})`];

describe("the runtime, not the worker, decides whether a required check passed", () => {
  it("accepts the step when the project command passes in the worktree on the reported revision", async () => {
    fs.writeFileSync(join(worktree, "ok.txt"), "present only in the worktree");
    const outcome = await runStep([
      node,
      "-e",
      "process.exit(require('node:fs').existsSync('ok.txt') ? 0 : 1)",
    ]);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.evidence).toMatchObject({ exitCode: 0, revision: head });
  });

  it("fails the step and starts rework when the command fails, although the worker reported it green", async () => {
    const outcome = await runStep(exitsWith(1));
    expect(outcome.status).toBe("failed");
    expect(outcome.failure).toBe("CHECK_FAILED");
    expect(outcome.evidence).toMatchObject({ exitCode: 1, revision: head });
    expect(outcome.reworkEvents.length).toBeGreaterThan(0);
  });

  it("fails the step and starts rework when the command times out", async () => {
    const outcome = await runStep([node, "-e", "setTimeout(() => {}, 60000)"], 300);
    expect(outcome.status).toBe("failed");
    expect(outcome.failure).toBe("CHECK_TIMED_OUT");
    expect(outcome.reworkEvents.length).toBeGreaterThan(0);
  });
});
