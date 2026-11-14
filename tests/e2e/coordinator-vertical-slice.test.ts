import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunCommandUseCases,
  createRunProcessRecovery,
} from "../../src/bootstrap/container.ts";
import { createRuntimeIpcServer } from "../../src/bootstrap/container.ts";
import type { IpcServer } from "../../src/interfaces/ipc/ipc-server.ts";
import { runCli } from "../../src/interfaces/cli/commands/create-program.ts";
import { sendCommand } from "../../src/interfaces/ipc/ipc-client.ts";
import { roleSchema } from "../../src/application/contracts/role.ts";
import type { MergeEvidence } from "../../src/application/contracts/merge-delivery.ts";
import type { TaskCompletion } from "../../src/application/ports/merge-delivery.ts";
import type { DispatchPlanner } from "../../src/application/ports/dispatch-planner.ts";
import type { StepRunReader } from "../../src/application/ports/attempt-store.ts";
import { claimProjectSession } from "../../src/application/services/claim-project-session.ts";
import type { MergeTaskPrDeps } from "../../src/application/use-cases/delivery/merge-task-pr.ts";
import type { ResumeRunDependencies } from "../../src/application/use-cases/runs/resume-run.ts";
import { dispatchRunStep } from "../../src/application/use-cases/runs/dispatch-run-step.ts";
import { createRunRecoveryUseCases } from "../../src/bootstrap/container.ts";
import { operationMarker } from "../../src/domain/delivery/operation-marker.ts";
import type { TaskStatus } from "../../src/domain/tasks/task-status.ts";
import { createLocalArtifactStore } from "../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createLocalCheckpointStore } from "../../src/infrastructure/artifacts/local-checkpoint-store.ts";
import { sha256ContentHasher } from "../../src/infrastructure/artifacts/sha256-content-hasher.ts";
import { loadWorkflowCatalog } from "../../src/infrastructure/config/load-workflow-catalog.ts";
import { createCliGitWorkspace } from "../../src/infrastructure/git/cli-git-workspace.ts";
import { createGithubMergeDelivery } from "../../src/infrastructure/github/github-merge-delivery.ts";
import { createGithubPrDelivery } from "../../src/infrastructure/github/github-pr-delivery.ts";
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
import { createSqlitePrMappingStore } from "../../src/infrastructure/persistence/sqlite/sqlite-pr-mapping-store.ts";
import {
  createSqliteRecoveryRunReader,
  createSqliteStepRunReader,
} from "../../src/infrastructure/persistence/sqlite/sqlite-recovery-run-reader.ts";
import { createSqliteRunPlanStore } from "../../src/infrastructure/persistence/sqlite/sqlite-run-plan-store.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { callCli } from "../../templates/bridges/claude-code/omi-squad/bridge.ts";
import type {
  BridgeConfig,
  BridgeOutcome,
  BridgeRequest,
} from "../../templates/bridges/claude-code/omi-squad/bridge.ts";
import { FakeGithub } from "../contract/github/fake-github.ts";
import {
  dispatchInput,
  h,
  rig,
  catalog,
  skillEvidence,
} from "../unit/application/use-cases/runs/run-fakes.ts";
import { createFakeWsl } from "../unit/templates/wsl-fakes.ts";

/**
 * The OMI-030 vertical slice. The Coordinator side is the real bridge; `wsl.exe` is replaced by
 * a fake that rebuilds the argument vector wsl.exe would give the shim and runs the real CLI
 * program against a real runtime socket. Behind it: real SQLite state, real git worktrees, the
 * real use cases, a fake GitHub and a fake worker executor. No part of the M4 template library
 * is used: the only workflow is the minimal fixture next to this test.
 */
const REPO = "acme/app";
const ISSUE = 35;
const PR = 128;
const TASK = "task-35";
const BRANCH = "task/omi-030-coordinator-bridge";
const PR_HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = Date.parse("2026-11-11T08:00:00.000Z");
const WORKFLOW_DIR = resolve(import.meta.dirname, "../fixtures/workflows");
const ISSUE_BODY = [
  "## Acceptance criteria",
  "- [ ] Bridge calls the CLI.",
  "- [ ] Fixture workflow reaches Done.",
  "## Implementation map",
  "- `src/application/map.ts`",
].join("\n");
const REVIEW_PASS =
  "**VERDICT:** PASS\n\nAC-1: met — bridge e2e\nAC-2: met — slice e2e, independent reviewer run";

const config: BridgeConfig = {
  distribution: "Ubuntu",
  repository: "/home/dev/project",
  shim: "/home/dev/project/.omi-squad/bin/omi",
};

let directory: string;
let db: StateDatabase | undefined;
let server: IpcServer | undefined;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"], HOME: directory, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (db?.open === true) db.close();
  db = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
});

type WorkerMode = "good" | "silent" | "hang";

async function slice() {
  directory = fs.mkdtempSync(join(tmpdir(), "omi-slice-"));
  const main = join(directory, "project");
  const root = join(directory, "artifacts");
  const socketPath = join(directory, "runtime.sock");
  fs.mkdirSync(main);
  fs.mkdirSync(root);
  git(main, "init", "--initial-branch=develop");
  git(main, "config", "user.email", "fixture@example.test");
  git(main, "config", "user.name", "Fixture");
  fs.writeFileSync(join(main, "README.md"), "base\n");
  git(main, "add", "README.md");
  git(main, "commit", "-m", "seed");
  const database = openStateDatabase(join(directory, "state.db"));
  db = database;
  applyMigrations(database, loadMigrations(resolve(import.meta.dirname, "../../migrations")));
  const at = new Date(NOW).toISOString();
  database
    .prepare(
      "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', ?, 'h', ?, ?)",
    )
    .run(REPO, at, at);
  database
    .prepare(
      "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES (?, 'p', 'I_35', ?, 'h', ?, '{}', ?)",
    )
    .run(TASK, ISSUE, at, at);

  // Clock: virtual, advanced by the use cases' own sleeps, so a `wait` timeout costs no real time.
  const clock = { ms: NOW };
  const now = () => clock.ms;
  let sequence = 0;
  const nextId = () => `id-${String(++sequence)}`;

  const state = createSqliteStateUnitOfWork(database);
  const session = claimProjectSession({
    leases: createSqliteLeaseStore(database),
    state,
    owner: "runtime-1",
    now,
    nextId,
    leaseMs: 3_600_000,
  });
  const runs = createSqliteRecoveryRunReader(database);
  const steps: StepRunReader = createSqliteStepRunReader(database);
  const plans = createSqliteRunPlanStore(database);
  const workflows = await loadWorkflowCatalog(WORKFLOW_DIR, ["minimal-delivery"]);
  const artifacts = createLocalArtifactStore(root, database);
  const checkpoints = createLocalCheckpointStore(root, database);
  const workspaces = createCliGitWorkspace(
    { mainWorktreePath: main },
    createSqliteLeaseStore(database),
  );

  // Stand-ins for the parts without a SQLite adapter yet: attempts live in memory and mirror
  // their lifecycle rows into SQLite for the production process-reference adapter.
  const r = rig();
  const createAttempt = r.attempts.create.bind(r.attempts);
  const setAttemptStatus = r.attempts.setStatus.bind(r.attempts);
  r.attempts.create = (record) => {
    database
      .prepare(
        "INSERT INTO agent_attempts (id, step_run_id, attempt_number, executor_id, model_id, profile_id, status, started_at) VALUES (?, ?, ?, ?, 'fixture', 'fixture', ?, ?)",
      )
      .run(
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
    database.prepare("UPDATE agent_attempts SET status = ? WHERE id = ?").run(status, id);
    setAttemptStatus(id, status);
  };

  // The fake worker: reports a result for the attempt it was given, like a real adapter would
  // deliver the worker's final message.
  const worker = { mode: "good" as WorkerMode };
  const baseCollect = r.executor.collectResult.bind(r.executor);
  r.executor.collectResult = async (handle) => {
    const execution = await baseCollect(handle);
    if (worker.mode === "hang") return new Promise(() => undefined);
    if (worker.mode === "silent") return execution;
    const attempt = r.attempts.get(handle.attemptId);
    const request = r.executor.started.find((entry) => entry.attemptId === handle.attemptId);
    if (attempt === undefined || request === undefined) throw new Error("unknown attempt");
    const publish = (path: string, text: string) =>
      artifacts.write({
        id: nextId(),
        path,
        bytes: new TextEncoder().encode(text),
        classification: "report",
        createdAt: new Date(now()).toISOString(),
      });
    const base = `attempts/${attempt.id}`;
    const report = publish(`${base}/reports/${attempt.stepId}.md`, `report of ${attempt.id}`);
    const proofs = attempt.requiredChecks.map((id) => ({
      id,
      artifact: publish(`${base}/reports/${id}.txt`, "all green"),
    }));
    const evidence = proofs.map(({ id, artifact }) => ({ id, evidenceRef: artifact.path }));
    const skillProof = skillEvidence(attempt, publish);
    const head = git(request.workspace, "rev-parse", "HEAD");
    return {
      ...execution,
      finalMessage: JSON.stringify({
        schemaVersion: 1,
        runId: attempt.runId,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        status: "succeeded",
        summary: `${attempt.stepId} done`,
        artifacts: [report, ...proofs.map(({ artifact }) => artifact), ...skillProof.artifacts],
        revision: { headSha: head, baseSha: head },
        checks: evidence,
        skillsApplied: skillProof.skillsApplied,
        findings: [],
      }),
    };
  };

  const developerCatalog = catalog();
  const resolutionCatalog = {
    ...developerCatalog,
    roles: [
      ...developerCatalog.roles,
      {
        definition: roleSchema.parse({
          schema_version: 1,
          id: "reviewer",
          version: 1,
          title: "Reviewer",
          description: "Reviews.",
          skills: ["debugging"],
          rules: [],
        }),
        sha256: h("2"),
      },
    ],
  };
  const dispatchDeps = {
    ...r.deps,
    catalog: resolutionCatalog,
    steps,
    attempts: r.attempts,
    artifacts,
    workspaces,
    unitOfWork: { commit: (change: Parameters<typeof state.commit>[0]) => session.commit(change) },
    now,
    nextId,
  };
  const planner: DispatchPlanner = {
    plan: ({ stepId }) =>
      Promise.resolve(
        dispatchInput({
          taskId: "omi-030",
          slug: "omi-030",
          owner: nextId(),
          role: stepId === "review" ? "reviewer" : "developer",
          requiredChecks: stepId === "implement" ? ["unit-tests"] : [],
          context: {
            taskSnapshot: { issueNumber: ISSUE, title: "Bridge", body: "Slice" },
            acceptanceCriteria: ["Bridge calls the CLI.", "Fixture workflow reaches Done."],
            businessBaselineHash: h("9"),
            capabilityProfile: { id: "standard", min_effort: "medium" },
            inputArtifacts: [],
            previousFindings: [],
            expectedOutputSchema: "step-result",
            allowedScope: { paths: ["src"] },
            approvalRefs: [],
          },
        }),
      ),
  };

  const workspace = workspaces.createTask({
    taskId: "omi-030",
    slug: "omi-030",
    owner: "setup",
    now: at,
    expiresAt: new Date(NOW + 60_000).toISOString(),
  });
  if (!workspace.ok) throw workspace.error;

  const completions: Promise<void>[] = [];
  const { processes } = createRunProcessRecovery({
    database,
    session,
    attempts: r.attempts,
    now,
  });
  const remote = new FakeGithub({ now });
  const client = createGithubRestClient({
    transport: remote,
    now,
    random: () => 0,
    sleep: () => Promise.resolve(),
    policy: { maxTries: 1 },
  });
  const githubDeps = {
    outbox: createSqliteOutboxStore(database),
    artifacts,
    github: createGithubRemote(client),
    now,
    newEventId: nextId,
    reconcileGraceMs: 120_000,
  };
  const dispatchViaRunStep = (runId: string, stepId: string) =>
    dispatchRunStep(
      {
        ...dispatchDeps,
        runs,
        plans,
        workflows,
        session,
        planner,
        track: (completion) => completions.push(completion),
      },
      { runId, stepId },
    );
  const resumeDeps: ResumeRunDependencies = {
    session,
    runs,
    attempts: r.attempts,
    processes,
    checkpoints,
    artifacts,
    workspaces,
    github: githubDeps,
    now,
    nextId,
    validateGates: () => Promise.resolve({ ok: true }),
    dispatch: async (_checkpoint, step) => {
      const result = await dispatchViaRunStep(step.runId, step.stepId);
      return result.ok ? { ok: true, attemptId: result.attemptId } : result;
    },
  };
  const recovery = createRunRecoveryUseCases({
    ...resumeDeps,
    hasher: sha256ContentHasher,
    snapshot: (runId) => {
      const run = runs.listSteps(runId);
      const open = run.find((step) => step.status !== "succeeded") ?? run[0];
      return {
        workspacePath: workspace.value.path,
        stepRunId: open?.id ?? "none",
        stepId: open?.stepId ?? "none",
        hashes: { config: h("1"), template: h("2") },
        taskSnapshot: { issueNumber: ISSUE, title: "Bridge", body: "Slice" },
        acceptanceCriteria: ["Bridge calls the CLI.", "Fixture workflow reaches Done."],
        businessBaselineHash: h("9"),
        counters: { retryCount: 0 },
        nextAction: { action: "dispatch-step", stepId: open?.stepId ?? "none" },
      };
    },
  });

  // GitHub for the delivery gate.
  remote.issues.push({
    number: ISSUE,
    repo: REPO,
    title: "Coordinator bridge",
    body: ISSUE_BODY,
    createdAt: at,
  });
  remote.pulls.push({
    number: PR,
    repo: REPO,
    title: "Bridge",
    body: `Issue: #${String(ISSUE)}\n${operationMarker(`create-pr:${REPO}:${TASK}:${BRANCH}:develop`)}`,
    createdAt: at,
    head: BRANCH,
    base: "develop",
    headSha: PR_HEAD,
    author: "omi-bot",
  });
  remote.branches.set(`${REPO}:develop`, BASE);
  remote.commits.set(BASE, { repo: REPO, parents: [] });
  remote.commits.set(PR_HEAD, { repo: REPO, parents: [BASE] });
  remote.rules.set(`${REPO}:develop`, [
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } },
  ]);
  remote.checkRuns.push({
    repo: REPO,
    id: 1,
    name: "ci",
    headSha: PR_HEAD,
    status: "completed",
    conclusion: "success",
  });
  const task = { status: "in_progress" as TaskStatus, completions: [] as TaskCompletion[] };
  const attemptOf = (stepId: string) =>
    [...r.attempts.rows.values()].find((attempt) => attempt.stepId === stepId);
  const evidence: MergeEvidence = {
    authorRunIds: [],
    authorAgentIds: ["claude-implementer"],
    unresolvedMandatoryFindings: 0,
    workflowGatesPassed: true,
  };
  const merge: MergeTaskPrDeps = {
    now,
    newId: nextId,
    newEventId: nextId,
    reconcileGraceMs: 120_000,
    batchSize: 10,
    jitter: () => 0,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 },
    artifacts,
    unitOfWork: state,
    outbox: githubDeps.outbox,
    mappings: createSqlitePrMappingStore(database),
    leases: createSqliteLeaseStore(database),
    github: githubDeps.github,
    reader: createGithubMergeDelivery(client),
    evidence: {
      // The review is the step result of a separate run: present only once the review step ran.
      read: (_project, _task, headSha) => {
        const review = attemptOf("review");
        const author = attemptOf("implement");
        const reviewStep = review === undefined ? undefined : steps.get(review.stepRunId);
        return {
          ...evidence,
          authorRunIds: author === undefined ? [] : [author.id],
          ...(review !== undefined && reviewStep?.status === "succeeded"
            ? {
                review: {
                  reviewerRunId: review.id,
                  reviewerAgentId: "codex-reviewer",
                  headSha,
                  baseSha: BASE,
                  verdict: "pass" as const,
                  body: REVIEW_PASS,
                },
              }
            : {}),
        };
      },
    },
    tasks: {
      status: () => task.status,
      complete: (change) => {
        task.status = change.toStatus;
        task.completions.push(change);
        return { ok: true };
      },
    },
    mergeLockOwner: "runtime-1",
    mergeLockTtlMs: 60_000,
  };
  merge.mappings.save({
    projectId: "p",
    taskId: TASK,
    repository: REPO,
    issueNumber: ISSUE,
    prNumber: PR,
  });

  const useCases = createRunCommandUseCases({
    session,
    runs,
    plans,
    workflows,
    dispatch: dispatchDeps,
    planner,
    track: (completion) => completions.push(completion),
    recovery,
    merge,
    prepare: { ...merge, reader: createGithubPrDelivery(client) },
    sleep: (ms) => {
      clock.ms += ms;
      return Promise.resolve();
    },
    pollMs: 1000,
  });
  const runtimeServer = createRuntimeIpcServer({
    socketPath,
    identity: { runtimeVersion: "0.0.0", startedAt: at },
    activeRuns: runs,
    runs: useCases,
  });
  server = runtimeServer;
  await runtimeServer.start();

  // wsl.exe stand-in: the real CLI program, in-process, against the real socket.
  const wsl = createFakeWsl(async (call) => {
    expect(call).toMatchObject({
      distribution: config.distribution,
      repository: config.repository,
      shim: config.shim,
    });
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(call.cliArgs, {
      sendCommand,
      defaultSocketPath: socketPath,
      timeoutMs: 10_000,
      version: "0.0.0",
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      readStdin: () => Promise.resolve(call.stdin),
    });
    return { stdout, stderr, exitCode };
  });
  const bridge = (request: BridgeRequest): Promise<BridgeOutcome> =>
    callCli(config, request, { spawn: wsl.spawn, platform: "win32" });
  const ok = async (request: BridgeRequest): Promise<Record<string, unknown>> => {
    const outcome = await bridge(request);
    if (!outcome.ok) throw new Error(`${request.command} failed: ${JSON.stringify(outcome)}`);
    return outcome.result as Record<string, unknown>;
  };
  const runStatus = (runId: string) =>
    (
      database.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(runId) as
        { status: string } | undefined
    )?.status;
  const stepStatuses = (runId: string) =>
    Object.fromEntries(runs.listSteps(runId).map((step) => [step.stepId, step.status]));
  /** Payloads of the audit events of one kind, parsed. */
  const events = (kind: string): unknown[] =>
    (
      database.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY rowid").all(kind) as {
        payload: string;
      }[]
    ).map((row) => JSON.parse(row.payload) as unknown);
  const planned = async () => {
    const plan = await ok({ command: "plan", issueNumber: ISSUE, workflowId: "minimal-delivery" });
    return plan["runId"] as string;
  };
  const runWorkerStep = async (runId: string, stepId: string) => {
    await ok({ command: "dispatch", runId, stepId });
    return ok({ command: "wait", runId, timeoutSeconds: 60 });
  };
  const writes = (method: string, pathIncludes: string) =>
    remote.requests.filter((req) => req.method === method && req.path.includes(pathIncludes))
      .length;
  return {
    bridge,
    ok,
    wsl,
    worker,
    planned,
    runWorkerStep,
    runStatus,
    stepStatuses,
    events,
    remote,
    task,
    writes,
    r,
    completions,
  };
}

const deliver = (runId: string, headSha = PR_HEAD): BridgeRequest => ({
  command: "deliver",
  runId,
  prNumber: PR,
  reviewedHeadSha: headSha,
  requiredChecks: ["ci"],
});

describe("AC1 · the Claude Code bridge calls the CLI", () => {
  it("reaches the runtime through wsl.exe --exec with typed argv and reads versioned JSON", async () => {
    const s = await slice();
    const status = await s.ok({ command: "status" });
    expect(status).toMatchObject({
      schemaVersion: 1,
      state: "ready",
      runtimeVersion: "0.0.0",
      runs: [],
    });
    expect(s.wsl.executables).toEqual(["wsl.exe"]);
    expect(s.wsl.calls).toEqual([
      {
        distribution: config.distribution,
        repository: config.repository,
        shim: config.shim,
        cliArgs: ["--json", "status"],
        stdin: "",
      },
    ]);
  });

  it("reports a runtime that is not up as runtime-unavailable, never as a result", async () => {
    const s = await slice();
    await server?.stop();
    server = undefined;
    const outcome = await s.bridge({ command: "status" });
    expect(outcome).toMatchObject({ ok: false, kind: "runtime-unavailable", exitCode: 3 });
  });

  it("reports a command the runtime refuses as refused with the stable reason", async () => {
    const s = await slice();
    const outcome = await s.bridge({
      command: "plan",
      issueNumber: 999,
      workflowId: "minimal-delivery",
    });
    expect(outcome).toMatchObject({
      ok: false,
      kind: "refused",
      exitCode: 4,
      code: "COMMAND_REFUSED",
      message: "TASK_NOT_FOUND",
    });
  });
});

describe("AC2 · the minimal fixture workflow takes one Issue to Done", () => {
  it("plan → dispatch → result → review → merge gate → close", async () => {
    const s = await slice();
    const runId = await s.planned();
    expect(s.stepStatuses(runId)).toEqual({ implement: "ready", review: "pending" });

    // A step whose dependency has not succeeded cannot be dispatched.
    expect(await s.bridge({ command: "dispatch", runId, stepId: "review" })).toMatchObject({
      ok: false,
      kind: "refused",
      message: "STEP_NOT_READY",
    });

    const afterImplement = await s.runWorkerStep(runId, "implement");
    expect(afterImplement).toMatchObject({ timedOut: false });
    expect(s.stepStatuses(runId)).toEqual({ implement: "succeeded", review: "ready" });

    // Nothing merges before every step succeeded.
    expect(await s.bridge(deliver(runId))).toMatchObject({
      ok: false,
      kind: "refused",
      message: "STEPS_NOT_SUCCEEDED",
    });
    expect(s.writes("PUT", "/merge")).toBe(0);

    await s.runWorkerStep(runId, "review");
    expect(s.stepStatuses(runId)).toEqual({ implement: "succeeded", review: "succeeded" });
    expect(s.runStatus(runId)).toBe("running");

    // The gate checks the exact head: a moved head merges nothing and leaves the run open.
    expect(await s.bridge(deliver(runId, "c".repeat(40)))).toMatchObject({
      ok: false,
      kind: "refused",
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
    expect(s.runStatus(runId)).toBe("running");

    const delivered = await s.ok(deliver(runId));
    expect(delivered).toMatchObject({ status: "done", delivery: { status: "done", ticked: 2 } });
    const pull = s.remote.pulls.find((entry) => entry.number === PR);
    expect(pull?.merged).toBe(true);
    expect(s.remote.issues.find((entry) => entry.number === ISSUE)?.state).toBe("closed");
    expect(s.task.status).toBe("done");
    expect(s.runStatus(runId)).toBe("succeeded");
    expect(s.writes("PUT", "/merge")).toBe(1);

    // Delivering again is safe and changes nothing; the finished run leaves the active list.
    expect(await s.ok(deliver(runId))).toMatchObject({ status: "done" });
    expect(s.writes("PUT", "/merge")).toBe(1);
    expect(await s.ok({ command: "status" })).toMatchObject({ runs: [] });

    // Worker, review and merge ran as three separate attempts/identities.
    const attempts = [...s.r.attempts.rows.values()];
    expect(attempts.map((attempt) => attempt.stepId)).toEqual(["implement", "review"]);
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(2);
  });

  it("fails the step of a worker that exits 0 without a valid result, and delivers nothing", async () => {
    const s = await slice();
    const runId = await s.planned();
    s.worker.mode = "silent";
    await s.runWorkerStep(runId, "implement");
    expect(s.stepStatuses(runId)).toEqual({ implement: "failed", review: "pending" });
    expect(await s.bridge({ command: "dispatch", runId, stepId: "review" })).toMatchObject({
      ok: false,
      message: "STEP_NOT_READY",
    });
    expect(await s.bridge(deliver(runId))).toMatchObject({
      ok: false,
      message: "STEPS_NOT_SUCCEEDED",
    });
    expect(s.task.status).toBe("in_progress");
  });

  it("refuses to merge when the independent review is absent from the evidence", async () => {
    const s = await slice();
    const runId = await s.planned();
    await s.runWorkerStep(runId, "implement");
    await s.runWorkerStep(runId, "review");
    // The reviewer's attempt is forgotten, as if no review had been recorded.
    s.r.attempts.rows.delete(
      [...s.r.attempts.rows.values()].find((a) => a.stepId === "review")?.id ?? "",
    );
    expect(await s.bridge(deliver(runId))).toMatchObject({ ok: false, kind: "refused" });
    expect(s.writes("PUT", "/merge")).toBe(0);
    expect(s.task.status).toBe("in_progress");
  });

  it("refuses a second active run for the same Issue", async () => {
    const s = await slice();
    await s.planned();
    expect(
      await s.bridge({ command: "plan", issueNumber: ISSUE, workflowId: "minimal-delivery" }),
    ).toMatchObject({ ok: false, message: "ACTIVE_RUN_EXISTS" });
  });
});

describe("AC3 · pause, new session and manual Coordinator-profile switch", () => {
  it("pauses on request, records the reason, and resumes from the checkpoint", async () => {
    const s = await slice();
    const runId = await s.planned();
    await s.runWorkerStep(runId, "implement");
    const reason = 'context is full; "quoted" $(id)\nsecond line';
    const paused = await s.ok({ command: "pause", runId, reason });
    expect(typeof paused["checkpointId"]).toBe("string");
    expect(s.runStatus(runId)).toBe("paused");
    expect(s.stepStatuses(runId)).toEqual({ implement: "succeeded", review: "paused" });
    expect(s.events("run.pause_requested")).toMatchObject([{ runId, reason }]);
    // The reason travelled on stdin, never on the command line.
    expect(s.wsl.calls.at(-1)).toMatchObject({
      cliArgs: ["--json", "pause", `--run=${runId}`, "--reason-stdin"],
      stdin: reason,
    });

    const resumed = await s.ok({ command: "resume", runId });
    expect(typeof resumed["attemptId"]).toBe("string");
    await s.ok({ command: "wait", runId, timeoutSeconds: 60 });
    expect(s.stepStatuses(runId)).toEqual({ implement: "succeeded", review: "succeeded" });
    expect(await s.ok(deliver(runId))).toMatchObject({ status: "done" });
  });

  it("ends a session cleanly: pauses every run, lets a new session find and resume it", async () => {
    const s = await slice();
    const runId = await s.planned();
    await s.runWorkerStep(runId, "implement");

    const handoff = await s.ok({ command: "handoff", reason: "new-session" });
    expect(handoff).toMatchObject({
      paused: [{ runId }],
      alreadyStopped: [],
    });
    expect(s.runStatus(runId)).toBe("paused");
    expect(s.events("coordinator.handoff")).toMatchObject([
      { reason: "new-session", paused: [{ runId }] },
    ]);
    expect(s.wsl.calls.at(-1)?.cliArgs).toEqual(["--json", "session", "new"]);

    // A new Coordinator session knows nothing; the runtime tells it what is unfinished.
    expect(await s.ok({ command: "status" })).toMatchObject({
      runs: [{ runId, status: "paused" }],
    });
    expect(await s.ok({ command: "status", runId })).toMatchObject({
      run: { runId, status: "paused" },
    });
    await s.ok({ command: "resume", runId });
    await s.ok({ command: "wait", runId, timeoutSeconds: 60 });
    expect(s.stepStatuses(runId)).toEqual({ implement: "succeeded", review: "succeeded" });

    // A second handoff with nothing running pauses nothing new and still succeeds.
    const second = await s.ok({ command: "handoff", reason: "new-session" });
    expect(second).toMatchObject({ paused: [{ runId }] });
  });

  it("records a manual Coordinator-profile switch and never touches a login", async () => {
    const s = await slice();
    const runId = await s.planned();
    const switched = await s.ok({
      command: "handoff",
      reason: "profile-switch",
      toProfile: "coordinator-b",
    });
    expect(switched).toMatchObject({ paused: [{ runId }] });
    expect(s.events("coordinator.handoff")).toMatchObject([
      { reason: "profile-switch", toProfile: "coordinator-b" },
    ]);
    expect(s.wsl.calls.at(-1)?.cliArgs).toEqual([
      "--json",
      "coordinator",
      "switch",
      "--to=coordinator-b",
    ]);
    expect(s.runStatus(runId)).toBe("paused");
  });

  it("refuses to call the session safe to end while a worker cannot be proven stopped", async () => {
    const s = await slice();
    const runId = await s.planned();
    s.worker.mode = "hang";
    await s.ok({ command: "dispatch", runId, stepId: "implement" });
    const outcome = await s.bridge({ command: "handoff", reason: "new-session" });
    expect(outcome).toMatchObject({ ok: false, kind: "refused", code: "COMMAND_REFUSED" });
    expect(outcome.ok ? "" : outcome.message).toContain("PAUSE_FAILED");
    expect(s.runStatus(runId)).toBe("running");
    expect(s.events("coordinator.handoff")).toEqual([]);
  });

  it("waits with a timeout while a worker keeps running", async () => {
    const s = await slice();
    const runId = await s.planned();
    s.worker.mode = "hang";
    await s.ok({ command: "dispatch", runId, stepId: "implement" });
    expect(await s.ok({ command: "wait", runId, timeoutSeconds: 2 })).toMatchObject({
      timedOut: true,
      run: { status: "running" },
    });
  });
});

describe("AC4 · no full M4 template library is required", () => {
  it("runs from a directory that holds only the minimal fixture workflow", async () => {
    expect(fs.readdirSync(WORKFLOW_DIR)).toEqual(["minimal-delivery.yaml"]);
    const s = await slice();
    const runId = await s.planned();
    expect(s.stepStatuses(runId)).toEqual({ implement: "ready", review: "pending" });
    // Naming a library workflow that is not installed is refused, not defaulted.
    expect(
      await s.bridge({ command: "plan", issueNumber: 1, workflowId: "feature" }),
    ).toMatchObject({
      ok: false,
      message: "WORKFLOW_UNKNOWN",
    });
  });
});
