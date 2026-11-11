import { createRunProcessRecovery } from "../../src/bootstrap/container.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GithubOperation } from "../../src/application/contracts/github-operation.ts";
import type { ArtifactReference } from "../../src/application/contracts/artifact.ts";
import type { StepRunReader } from "../../src/application/ports/attempt-store.ts";
import type { ResumeRunDependencies } from "../../src/application/use-cases/runs/resume-run.ts";
import { resumeRun } from "../../src/application/use-cases/runs/resume-run.ts";
import { pauseRun } from "../../src/application/use-cases/runs/pause-run.ts";
import { dispatchStep } from "../../src/application/use-cases/runs/dispatch-step.ts";
import { recordStepResult } from "../../src/application/use-cases/runs/record-step-result.ts";
import { writeCheckpoint } from "../../src/application/use-cases/runs/write-checkpoint.ts";
import { flushOutbox } from "../../src/application/use-cases/sync/flush-outbox.ts";
import { claimProjectSession } from "../../src/application/services/claim-project-session.ts";
import { queueGithubOperation } from "../../src/application/services/queue-github-operation.ts";
import { createLocalCheckpointStore } from "../../src/infrastructure/artifacts/local-checkpoint-store.ts";
import { createLocalArtifactStore } from "../../src/infrastructure/artifacts/local-artifact-store.ts";
import { sha256ContentHasher } from "../../src/infrastructure/artifacts/sha256-content-hasher.ts";
import { createCliGitWorkspace } from "../../src/infrastructure/git/cli-git-workspace.ts";
import { createGithubRemote } from "../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../src/infrastructure/github/github-rest-client.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteLeaseStore } from "../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteOutboxStore } from "../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createSqliteRecoveryRunReader } from "../../src/infrastructure/persistence/sqlite/sqlite-recovery-run-reader.ts";
import {
  startSupervisedProcess,
  type SupervisedProcess,
} from "../../src/infrastructure/processes/supervised-process.ts";
import { FakeGithub } from "../contract/github/fake-github.ts";
import { dispatchInput, h, rig } from "../unit/application/use-cases/runs/run-fakes.ts";

class SimulatedCrash extends Error {}
let directory: string;
let db: StateDatabase;
const children: SupervisedProcess[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"], HOME: directory, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "omi-recovery-"));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.cancel("SIGINT", "group");
    await child.exit;
  }
  if (db.open) db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const main = join(directory, "project");
  const root = join(directory, "artifacts");
  fs.mkdirSync(main);
  fs.mkdirSync(root);
  git(main, "init", "--initial-branch=develop");
  git(main, "config", "user.email", "fixture@example.test");
  git(main, "config", "user.name", "Fixture");
  fs.writeFileSync(join(main, "README.md"), "base\n");
  git(main, "add", "README.md");
  git(main, "commit", "-m", "seed");
  const headSha = git(main, "rev-parse", "HEAD");
  db = openStateDatabase(join(directory, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../migrations")));
  const at = "2026-11-11T00:00:00.000Z";
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('t', 'p', 'I_32', 32, 'h', ?, '{}', ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at) VALUES ('run-1', 't', 'h', 'running', 'implementation', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at) VALUES ('step-1', 'run-1', 'implement', 'ready', ?, ?)",
  ).run(at, at);
  const r = rig();
  let sequence = 0;
  const nextId = () => `recovery-${String(++sequence)}`;
  const clock = { ms: Date.parse(at) };
  const now = () => clock.ms;
  const remote = new FakeGithub({ now });
  // Stand-in attempt store retains the dispatch metadata in memory and mirrors lifecycle rows
  // into SQLite so the production process-reference adapter survives connection replacement.
  const createAttempt = r.attempts.create.bind(r.attempts);
  const setAttemptStatus = r.attempts.setStatus.bind(r.attempts);
  r.attempts.create = (record) => {
    db.prepare(
      "INSERT INTO agent_attempts (id, step_run_id, attempt_number, executor_id, model_id, profile_id, status, started_at) VALUES (?, ?, ?, ?, 'fixture', 'fixture', ?, ?)",
    ).run(
      record.id,
      record.stepRunId,
      record.attemptNumber,
      record.executor,
      record.status,
      record.startedAt,
    );
    createAttempt(record);
  };
  r.attempts.setStatus = (id, status) => {
    db.prepare("UPDATE agent_attempts SET status = ? WHERE id = ?").run(status, id);
    setAttemptStatus(id, status);
  };
  function wire() {
    const state = createSqliteStateUnitOfWork(db);
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(db),
      state,
      owner: nextId(),
      now,
      nextId,
      leaseMs: 60_000,
    });
    const runs = createSqliteRecoveryRunReader(db);
    const steps: StepRunReader = {
      get: (id) => runs.listSteps("run-1").find((step) => step.id === id),
    };
    const artifacts = createLocalArtifactStore(root, db);
    const checkpoints = createLocalCheckpointStore(root, db);
    const workspaces = createCliGitWorkspace(
      { mainWorktreePath: main },
      createSqliteLeaseStore(db),
    );
    const { processes: workerRecovery } = createRunProcessRecovery({
      database: db,
      session,
      attempts: r.attempts,
      now,
    });
    const github = {
      outbox: createSqliteOutboxStore(db),
      artifacts,
      github: createGithubRemote(
        createGithubRestClient({
          transport: remote,
          now,
          random: () => 0,
          sleep: () => Promise.resolve(),
          policy: { maxTries: 1 },
        }),
      ),
      now,
      newEventId: nextId,
      reconcileGraceMs: 120_000,
    };
    const dispatchDeps = {
      ...r.deps,
      steps,
      unitOfWork: {
        commit: (change: Parameters<typeof state.commit>[0]) => session.commit(change),
      },
      artifacts,
      workspaces,
      now,
      nextId,
    };
    const deps: ResumeRunDependencies = {
      session,
      runs,
      attempts: r.attempts,
      processes: workerRecovery,
      checkpoints,
      artifacts,
      workspaces,
      github,
      now,
      nextId,
      validateGates: () => Promise.resolve({ ok: true }),
      dispatch: async (checkpoint, step) => {
        const result = await dispatchStep(
          dispatchDeps,
          dispatchInput({
            stepRunId: step.id,
            taskId: "omi-027",
            slug: "resume-recovery",
            owner: nextId(),
            context: {
              ...rContext(),
              checkpointRef: `checkpoints/run-1/${checkpoint.checkpointId}.json`,
            },
          }),
        );
        return result.ok ? { ok: true, attemptId: result.attempt.id } : result;
      },
    };
    return {
      state,
      session,
      runs,
      steps,
      artifacts,
      checkpoints,
      workspaces,
      workerRecovery,
      github,
      dispatchDeps,
      deps,
    };
  }
  let runtime = wire();
  function rContext() {
    return {
      taskSnapshot: { issueNumber: 32, title: "Recovery", body: "Resume" },
      acceptanceCriteria: ["works"],
      businessBaselineHash: h("9"),
      capabilityProfile: { id: "standard", min_effort: "medium" },
      inputArtifacts: [],
      previousFindings: [],
      expectedOutputSchema: "step-result",
      allowedScope: { paths: ["src"] },
      approvalRefs: [],
    };
  }
  const workspace = runtime.workspaces.createTask({
    taskId: "omi-027",
    slug: "resume-recovery",
    owner: "setup",
    now: at,
    expiresAt: "2026-11-11T00:01:00.000Z",
  });
  if (!workspace.ok) throw workspace.error;
  const snapshot = (outputs: readonly ArtifactReference[] = []) => ({
    workspacePath: workspace.value.path,
    stepRunId: "step-1",
    stepId: "implement",
    hashes: { config: h("1"), template: h("2") },
    taskSnapshot: rContext().taskSnapshot,
    acceptanceCriteria: ["works"],
    businessBaselineHash: h("9"),
    counters: { retryCount: 0 },
    nextAction: { action: "dispatch-step", stepId: "implement" },
    outputs: [...outputs],
  });
  const save = (outputs: readonly ArtifactReference[] = []) => {
    clock.ms += 1;
    const result = writeCheckpoint(
      { ...runtime.deps, hasher: sha256ContentHasher },
      { ...snapshot(outputs), runId: "run-1", kind: "before-dispatch" },
    );
    if (!result.ok) throw new Error(result.reason);
    return result.checkpoint;
  };
  const initial = save();
  const restart = () => {
    // Model abrupt owner death: leave the project reservation unreleased, then advance beyond
    // expiry. The new session takes a higher generation; old writes are fenced out.
    db.close();
    clock.ms += 60_001;
    db = openStateDatabase(join(directory, "state.db"));
    runtime = wire();
    return runtime;
  };
  const enqueue = (key: string, operation: GithubOperation) =>
    queueGithubOperation(
      {
        artifacts: runtime.artifacts,
        outbox: runtime.github.outbox,
        unitOfWork: { commit: (change) => runtime.session.commit(change) },
        now,
        newId: nextId,
      },
      key,
      operation,
    );
  const flush = (crash = false) =>
    flushOutbox({
      ...runtime.github,
      outbox: crash
        ? {
            ...runtime.github.outbox,
            transition: (change) => {
              if (change.to === "succeeded") throw new SimulatedCrash();
              return runtime.github.outbox.transition(change);
            },
          }
        : runtime.github.outbox,
      retryBudget: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      jitter: () => 0,
      batchSize: 20,
    });
  const start = () =>
    dispatchStep(
      runtime.dispatchDeps,
      dispatchInput({ taskId: "omi-027", slug: "resume-recovery", owner: nextId() }),
    );
  const writeArtifact = (path: string, text: string) =>
    runtime.artifacts.write({
      id: nextId(),
      path,
      bytes: new TextEncoder().encode(text),
      classification: "report",
      createdAt: new Date(now()).toISOString(),
    });
  return {
    r,
    remote,
    clock,
    root,
    main,
    headSha,
    workspace: workspace.value,
    initial,
    save,
    restart,
    enqueue,
    flush,
    start,
    snapshot,
    writeArtifact,
    runtime: () => runtime,
  };
}

const pull: GithubOperation = {
  type: "pull_request.create",
  repo: "acme/app",
  head: "task/omi-027-resume-recovery",
  base: "develop",
  title: "Recovery",
  body: "Issue: #32",
};

describe("recovery with faults, SQLite restart, sandbox Git and fake GitHub", () => {
  it("finds a PR created before the process could record it, with no second POST", async () => {
    const r = setup();
    r.enqueue("pr:run-1", pull);
    await expect(r.flush(true)).rejects.toThrow(SimulatedCrash);
    expect(r.remote.pulls).toHaveLength(1);
    expect(r.runtime().github.outbox.get("pr:run-1")?.state).toBe("in_flight");
    const runtime = r.restart();
    const resumed = await resumeRun(runtime.deps, { runId: "run-1" });
    expect(resumed).toMatchObject({ ok: true, github: { entries: [{ outcome: "succeeded" }] } });
    await r.flush();
    expect(r.remote.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(r.remote.pulls).toHaveLength(1);
  });

  it("reads back a merge after a crash and never sends a second merge", async () => {
    const r = setup();
    r.enqueue("pr:run-1", pull);
    await r.flush();
    const pr = r.remote.pulls[0];
    if (pr === undefined) throw new Error("PR missing");
    pr.headSha = r.headSha;
    r.enqueue("merge:run-1", {
      type: "pull_request.merge",
      base: "develop",
      repo: "acme/app",
      pullNumber: pr.number,
      expectedHeadSha: r.headSha,
      prOperationKey: "pr:run-1",
    });
    await expect(r.flush(true)).rejects.toThrow(SimulatedCrash);
    expect(pr.merged).toBe(true);
    const runtime = r.restart();
    expect(await resumeRun(runtime.deps, { runId: "run-1" })).toMatchObject({
      ok: true,
      github: { entries: [{ operationKey: "merge:run-1", outcome: "succeeded" }] },
    });
    await r.flush();
    expect(runtime.github.outbox.get("merge:run-1")?.state).toBe("succeeded");
    expect(r.remote.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it.each(["missing", "hash"])("reports a %s checkpoint and does not dispatch", async (fault) => {
    const r = setup();
    const path = join(r.root, r.initial.manifestPath);
    if (fault === "missing") fs.rmSync(path);
    else fs.appendFileSync(path, " ");
    const runtime = r.restart();
    expect(await resumeRun(runtime.deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "CHECKPOINT_MISSING",
      checkpointProblems: [
        {
          checkpointId: r.initial.id,
          reason: fault === "missing" ? "CHECKPOINT_FILE_MISSING" : "CHECKPOINT_HASH_MISMATCH",
        },
      ],
    });
    expect(r.r.executor.started).toEqual([]);
    // Diagnostics are retained on repeated recovery passes.
    expect(await resumeRun(runtime.deps, { runId: "run-1" })).toMatchObject({
      checkpointProblems: [{ checkpointId: r.initial.id }],
    });
  });

  it("falls back to the newest intact checkpoint and reports the damaged newer file", async () => {
    const r = setup();
    const newer = r.save();
    fs.rmSync(join(r.root, newer.manifestPath));
    const runtime = r.restart();
    expect(await resumeRun(runtime.deps, { runId: "run-1" })).toMatchObject({
      ok: true,
      checkpoint: { checkpointId: r.initial.id },
      checkpointProblems: [{ checkpointId: newer.id, reason: "CHECKPOINT_FILE_MISSING" }],
    });
  });

  it.each(["missing", "hash"])(
    "reports %s output artifacts even when the manifest is intact",
    async (fault) => {
      const r = setup();
      const output = r.writeArtifact("reports/output.md", "accepted");
      r.save([output]);
      if (fault === "missing") fs.rmSync(join(r.root, output.path));
      else fs.appendFileSync(join(r.root, output.path), "altered");
      expect(await resumeRun(r.restart().deps, { runId: "run-1" })).toMatchObject({
        ok: false,
        reason: fault === "missing" ? "ARTIFACT_MISSING" : "ARTIFACT_HASH_MISMATCH",
      });
      expect(r.r.executor.started).toEqual([]);
    },
  );

  it("recovers a dead worker's reserved worktree into a fresh attempt", async () => {
    const r = setup();
    const dispatched = await r.start();
    if (!dispatched.ok) throw new Error(dispatched.reason);
    const child = await startSupervisedProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: r.workspace.path,
      env: {},
      stdin: "",
      onStdoutLine: () => undefined,
      timeoutMs: 10_000,
      graceMs: 30,
      maxStdoutChars: 100,
      maxLineChars: 100,
      maxStderrChars: 100,
    });
    children.push(child);
    r.runtime().workerRecovery.track(dispatched.attempt, child);
    child.cancel("SIGINT", "group");
    await child.exit;
    const runtime = r.restart();
    expect(runtime.workerRecovery.inspect(dispatched.attempt)).toBe("stopped");
    expect(await resumeRun(runtime.deps, { runId: "run-1" })).toMatchObject({
      ok: true,
      stepRunId: "step-1",
    });
    const next = r.r.attempts.latestForStep("step-1");
    expect(next?.attemptNumber).toBe(2);
    expect(next?.id).not.toBe(dispatched.attempt.id);
    expect(next?.workspace.generation).toBeGreaterThan(dispatched.attempt.workspace.generation);
    expect(r.r.attempts.get(dispatched.attempt.id)?.status).toBe("interrupted");
  });

  it("preserves a live worker from an old session and its reservation", async () => {
    const r = setup();
    const dispatched = await r.start();
    if (!dispatched.ok) throw new Error(dispatched.reason);
    const child = await startSupervisedProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: r.workspace.path,
      env: {},
      stdin: "",
      onStdoutLine: () => undefined,
      timeoutMs: 10_000,
      graceMs: 30,
      maxStdoutChars: 100,
      maxLineChars: 100,
      maxStderrChars: 100,
    });
    children.push(child);
    r.runtime().workerRecovery.track(dispatched.attempt, child);
    const runtime = r.restart();
    expect(await resumeRun(runtime.deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "WORKER_NOT_OWNED",
    });
    expect(r.r.executor.started).toHaveLength(1);
    expect(process.kill(child.pid, 0)).toBe(true);
  });

  it("does not repeat an accepted result when the after-output checkpoint was lost", async () => {
    const r = setup();
    const dispatched = await r.start();
    if (!dispatched.ok) throw new Error(dispatched.reason);
    const report = r.writeArtifact(`${dispatched.attempt.artifactRoot}/report.md`, "accepted");
    const runtime = r.runtime();
    const recorded = recordStepResult(
      { ...runtime.dispatchDeps, checkpoint: () => ({ ok: false, reason: "CRASH" }) },
      {
        attemptId: dispatched.attempt.id,
        execution: await r.r.executor.collectResult(dispatched.handle),
        result: {
          schemaVersion: 1,
          runId: "run-1",
          stepId: "implement",
          attemptId: dispatched.attempt.id,
          status: "succeeded",
          summary: "Done",
          artifacts: [report],
          revision: { headSha: r.headSha, baseSha: r.headSha },
          checks: [{ id: "unit-tests", evidenceRef: report.path }],
          findings: [],
        },
      },
    );
    expect(recorded).toMatchObject({
      ok: true,
      stepStatus: "succeeded",
      checkpointFailure: "CRASH",
    });
    expect(await resumeRun(r.restart().deps, { runId: "run-1" })).toMatchObject({ ok: true });
    expect(r.r.executor.started).toHaveLength(1);
  });

  it("pauses an owned process before snapshot and preserves uncommitted files", async () => {
    const r = setup();
    const dispatched = await r.start();
    if (!dispatched.ok) throw new Error(dispatched.reason);
    const child = await startSupervisedProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: r.workspace.path,
      env: {},
      stdin: "",
      onStdoutLine: () => undefined,
      timeoutMs: 10_000,
      graceMs: 30,
      maxStdoutChars: 100,
      maxLineChars: 100,
      maxStderrChars: 100,
    });
    children.push(child);
    r.runtime().workerRecovery.track(dispatched.attempt, child);
    fs.writeFileSync(join(r.workspace.path, "uncommitted.txt"), "keep me");
    const runtime = r.runtime();
    expect(
      await pauseRun(
        { ...runtime.deps, hasher: sha256ContentHasher, snapshot: () => r.snapshot() },
        { runId: "run-1" },
      ),
    ).toMatchObject({ ok: true });
    expect(runtime.workerRecovery.inspect(dispatched.attempt)).toBe("stopped");
    expect(fs.readFileSync(join(r.workspace.path, "uncommitted.txt"), "utf8")).toBe("keep me");
    expect(await resumeRun(r.restart().deps, { runId: "run-1" })).toMatchObject({ ok: true });
  });
  it("fences a stale session's outbox writes if ownership changes during remote read-back", async () => {
    const r = setup();
    r.enqueue("pr:run-1", pull);
    await expect(r.flush(true)).rejects.toThrow(SimulatedCrash);
    const runtime = r.restart();
    const github = runtime.github.github;
    const deps = {
      ...runtime.deps,
      github: {
        ...runtime.github,
        github: {
          send: github.send.bind(github),
          lookup: async (request: Parameters<typeof github.lookup>[0]) => {
            const found = await github.lookup(request);
            r.clock.ms += 60_001;
            claimProjectSession({
              leases: createSqliteLeaseStore(db),
              state: runtime.state,
              owner: "successor",
              now: () => r.clock.ms,
              nextId: () => "successor-event",
              leaseMs: 60_000,
            });
            return found;
          },
        },
      },
    };
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "PROJECT_LOCK_LOST",
    });
    expect(runtime.github.outbox.get("pr:run-1")?.state).toBe("outcome_unknown");
    expect(r.r.executor.started).toEqual([]);
  });

  it.each(["start-identity", "generation", "malformed"])(
    "preserves a worker with mismatched %s",
    async (fault) => {
      const r = setup();
      const dispatched = await r.start();
      if (!dispatched.ok) throw new Error(dispatched.reason);
      const child = await startSupervisedProcess({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: r.workspace.path,
        env: {},
        stdin: "",
        onStdoutLine: () => undefined,
        timeoutMs: 10_000,
        graceMs: 30,
        maxStdoutChars: 100,
        maxLineChars: 100,
        maxStderrChars: 100,
      });
      children.push(child);
      r.runtime().workerRecovery.track(dispatched.attempt, child);
      // Simulate PID/start identity reuse or a stale process generation in durable metadata.
      if (fault === "generation")
        db.prepare(
          "UPDATE agent_attempts SET process_generation = process_generation + 1 WHERE id = ?",
        ).run(dispatched.attempt.id);
      else
        db.prepare("UPDATE agent_attempts SET process_started_at = ? WHERE id = ?").run(
          fault === "malformed" ? "invalid" : "00000000-0000-0000-0000-000000000000:1",
          dispatched.attempt.id,
        );
      expect(await resumeRun(r.runtime().deps, { runId: "run-1" })).toMatchObject({
        ok: false,
        reason: fault !== "start-identity" ? "WORKER_IDENTITY_UNKNOWN" : "WORKER_NOT_OWNED",
      });
      expect(process.kill(child.pid, 0)).toBe(true);
    },
  );

  it("reports changed uncommitted contents and leaves the user's file intact", async () => {
    const r = setup();
    const path = join(r.workspace.path, "uncommitted.txt");
    fs.writeFileSync(path, "checkpoint content");
    r.save();
    fs.writeFileSync(path, "changed after checkpoint");
    expect(await resumeRun(r.restart().deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "UNCOMMITTED_MISMATCH",
    });
    expect(fs.readFileSync(path, "utf8")).toBe("changed after checkpoint");
    expect(r.r.executor.started).toEqual([]);
  });
});
