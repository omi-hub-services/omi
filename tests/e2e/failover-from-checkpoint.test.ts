import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionResult } from "../../src/application/contracts/agent-execution.ts";
import { parseProfileMetadata } from "../../src/application/contracts/profile-metadata.ts";
import type { AgentExecutor } from "../../src/application/ports/agent-executor.ts";
import type { StepRunReader } from "../../src/application/ports/attempt-store.ts";
import { claimProjectSession } from "../../src/application/services/claim-project-session.ts";
import {
  failoverStep,
  type FailoverStepDependencies,
} from "../../src/application/use-cases/profiles/failover-step.ts";
import { retryStep } from "../../src/application/use-cases/runs/retry-step.ts";
import { workflowSchema } from "../../src/application/contracts/workflow.ts";
import { modelsConfigSchema } from "../../src/application/contracts/model-capability.ts";
import {
  effortPolicySchema,
  taskComplexitySchema,
} from "../../src/application/contracts/task-complexity.ts";
import { selectExecutor } from "../../src/application/use-cases/profiles/select-executor.ts";
import { dispatchStep } from "../../src/application/use-cases/runs/dispatch-step.ts";
import { writeCheckpoint } from "../../src/application/use-cases/runs/write-checkpoint.ts";
import type { ProfileMetadata } from "../../src/domain/profiles/profile-metadata.ts";
import { createRunProcessRecovery } from "../../src/bootstrap/container.ts";
import { createLocalArtifactStore } from "../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createLocalCheckpointStore } from "../../src/infrastructure/artifacts/local-checkpoint-store.ts";
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
import { createSqliteRecoveryRunReader } from "../../src/infrastructure/persistence/sqlite/sqlite-recovery-run-reader.ts";
import { createSqliteReworkRunReader } from "../../src/infrastructure/persistence/sqlite/sqlite-rework-run-reader.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createSqliteExecutorSelectionStore } from "../../src/infrastructure/profiles/sqlite-executor-selection-store.ts";
import { createSqliteProfileRegistry } from "../../src/infrastructure/profiles/sqlite-profile-registry.ts";
import {
  startSupervisedProcess,
  type SupervisedProcess,
} from "../../src/infrastructure/processes/supervised-process.ts";
import { FakeGithub } from "../contract/github/fake-github.ts";
import { dispatchInput, h, rig } from "../unit/application/use-cases/runs/run-fakes.ts";

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
  directory = fs.mkdtempSync(join(tmpdir(), "omi-failover-"));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.cancel("SIGINT", "group");
    await child.exit;
  }
  if (db.open) db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const at = "2026-11-11T00:00:00.000Z";
const models = {
  schema_version: 1,
  models: {
    opus: { executor: "claude-code", model: "opus-model", supported_efforts: ["high", "xhigh"] },
    codex: { executor: "codex", model: "codex-model", supported_efforts: ["high", "xhigh"] },
  },
  capability_profiles: {
    coding: { min_effort: "high" },
    "codex-only": { min_effort: "high", required_executor: "codex" },
  },
  verified_models: { coding: ["opus", "codex"], "codex-only": ["codex"] },
};
type ProfileSpec = {
  readonly id: string;
  readonly tool: "claude-code" | "codex";
  readonly group?: string;
  readonly preference: number;
};

function profile(spec: ProfileSpec, now: number): ProfileMetadata {
  return parseProfileMetadata({
    profileId: spec.id,
    tool: spec.tool,
    authMode: "subscription",
    credentialRef: `/profiles/${spec.id}`,
    accountGroupId: spec.group ?? spec.id,
    modelAllowlist: [spec.tool === "codex" ? "codex-model" : "opus-model"],
    state: "ready",
    lastProbeAt: now,
    probeTtlMs: 3_600_000,
    maxConcurrency: 1,
    accountGroupMaxConcurrency: 1,
    preference: spec.preference,
  });
}

function setup(specs: readonly ProfileSpec[]) {
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
  db = openStateDatabase(join(directory, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../migrations")));
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('t', 'p', 'I_21', 21, 'h', ?, '{}', ?)",
  ).run(at, at);
  // One failed quality cycle is already spent: a failover must leave it exactly as it is.
  db.prepare(
    "INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, failure_count, counted_cycle_ids, created_at, updated_at) VALUES ('run-1', 't', 'h', 'running', 'normal', 1, '[\"cycle-1\"]', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at) VALUES ('step-1', 'run-1', 'implement', 'ready', ?, ?)",
  ).run(at, at);

  const clock = { ms: Date.parse(at) };
  const now = () => clock.ms;
  let sequence = 0;
  const nextId = () => `failover-${String(++sequence)}`;
  const registry = createSqliteProfileRegistry(db);
  for (const spec of specs) registry.save(profile(spec, now()), now());
  const selections = createSqliteExecutorSelectionStore(db, registry);

  const r = rig();
  // The attempt row of a selected profile already exists as a reservation; dispatch completes it.
  const createAttempt = r.attempts.create.bind(r.attempts);
  const setAttemptStatus = r.attempts.setStatus.bind(r.attempts);
  r.attempts.create = (record) => {
    const reserved = db.prepare("SELECT 1 FROM agent_attempts WHERE id = ?").get(record.id);
    if (reserved === undefined) throw new Error("attempt was not reserved by selection");
    db.prepare("UPDATE agent_attempts SET status = ?, started_at = ? WHERE id = ?").run(
      record.status,
      record.startedAt,
      record.id,
    );
    createAttempt(record);
  };
  r.attempts.setStatus = (id, status) => {
    db.prepare("UPDATE agent_attempts SET status = ? WHERE id = ?").run(status, id);
    setAttemptStatus(id, status);
  };

  const state = createSqliteStateUnitOfWork(db);
  const session = claimProjectSession({
    leases: createSqliteLeaseStore(db),
    state,
    owner: nextId(),
    now,
    nextId,
    leaseMs: 3_600_000,
  });
  const runs = createSqliteRecoveryRunReader(db);
  const steps: StepRunReader = {
    get: (id) => runs.listSteps("run-1").find((step) => step.id === id),
  };
  const artifacts = createLocalArtifactStore(root, db);
  const checkpoints = createLocalCheckpointStore(root, db);
  const workspaces = createCliGitWorkspace({ mainWorktreePath: main }, createSqliteLeaseStore(db));
  const { processes } = createRunProcessRecovery({
    database: db,
    session,
    attempts: r.attempts,
    now,
  });
  const remote = new FakeGithub({ now });
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
    unitOfWork: { commit: (change: Parameters<typeof state.commit>[0]) => session.commit(change) },
    artifacts,
    workspaces,
    now,
    nextId,
  };
  // A Codex adapter stand-in: same fake process behaviour, reporting the codex executor.
  const codexExecutor: AgentExecutor = {
    executor: "codex",
    probe: () => r.executor.probe(),
    start: async (request) => ({ ...(await r.executor.start(request)), executor: "codex" }),
    events: () => r.executor.events(),
    cancel: () => r.executor.cancel(),
    collectResult: async (handle) => ({
      ...(await r.executor.collectResult({ ...handle, executor: "claude-code" })),
      executor: "codex",
    }),
  };
  const context = (capability: string, checkpointRef?: string) => ({
    taskSnapshot: { issueNumber: 21, title: "Failover", body: "Fail over" },
    acceptanceCriteria: ["works"],
    businessBaselineHash: h("9"),
    capabilityProfile: {
      id: capability,
      ...models.capability_profiles[capability as keyof typeof models.capability_profiles],
    },
    inputArtifacts: [],
    previousFindings: [],
    expectedOutputSchema: "step-result",
    allowedScope: { paths: ["src"] },
    approvalRefs: [],
    ...(checkpointRef === undefined ? {} : { checkpointRef }),
  });
  const bind = (
    capability: string,
    reservedAttemptId: string,
    profileHome: string,
    model: string,
    effort: string,
    executor: AgentExecutor,
    checkpointRef?: string,
  ) =>
    dispatchStep(
      { ...dispatchDeps, executor },
      dispatchInput({
        models,
        stepRunId: "step-1",
        reservedAttemptId,
        taskId: "omi-018",
        slug: "failover",
        owner: nextId(),
        context: context(capability, checkpointRef),
        execution: { profileHome, model, effort, access: "workspace-write", timeoutMs: 60_000 },
      }),
    );
  const executorFor = (tool: string): AgentExecutor =>
    tool === "codex" ? codexExecutor : r.executor;

  const deps: FailoverStepDependencies = {
    session,
    runs,
    attempts: r.attempts,
    processes,
    checkpoints,
    artifacts,
    workspaces,
    github,
    now,
    nextId,
    validateGates: () => Promise.resolve({ ok: true }),
    profiles: registry,
    selections,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 },
    jitter: () => 0,
    dispatch: async ({ checkpoint, selection }) => {
      const result = await bind(
        capabilityInUse.id,
        selection.attemptId,
        selection.profileHome,
        selection.candidate.model,
        selection.effort,
        executorFor(selection.candidate.executor),
        `checkpoints/run-1/${checkpoint.checkpointId}.json`,
      );
      return result.ok ? { ok: true, attemptId: result.attempt.id } : result;
    },
  };
  const capabilityInUse = { id: "coding" };
  const workspace = workspaces.createTask({
    taskId: "omi-018",
    slug: "failover",
    owner: "setup",
    now: at,
    expiresAt: "2026-11-11T00:01:00.000Z",
  });
  if (!workspace.ok) throw workspace.error;
  const checkpoint = () => {
    clock.ms += 1;
    const saved = writeCheckpoint(
      { ...deps, hasher: sha256ContentHasher },
      {
        runId: "run-1",
        kind: "before-dispatch",
        workspacePath: workspace.value.path,
        stepRunId: "step-1",
        stepId: "implement",
        hashes: { config: h("1"), template: h("2") },
        taskSnapshot: { issueNumber: 21, title: "Failover", body: "Fail over" },
        acceptanceCriteria: ["works"],
        businessBaselineHash: h("9"),
        counters: { retryCount: 0 },
        nextAction: { action: "dispatch-step", stepId: "implement" },
        outputs: [],
      },
    );
    if (!saved.ok) throw new Error(saved.reason);
    return saved.checkpoint;
  };
  const initial = checkpoint();

  /** First attempt: selection reserves, dispatch completes the reservation and starts it. */
  async function start(capability = "coding") {
    capabilityInUse.id = capability;
    const selection = selectExecutor(selections, {
      attemptId: "attempt-1",
      stepRunId: "step-1",
      attemptNumber: 1,
      capabilityProfile: capability,
      now: now(),
      models,
    });
    if (selection.outcome !== "selected") throw new Error("no first profile");
    const dispatched = await bind(
      capability,
      "attempt-1",
      `/profiles/${selection.candidate.profileId}`,
      selection.candidate.model,
      selection.effort,
      executorFor(selection.candidate.executor),
    );
    if (!dispatched.ok) throw new Error(dispatched.reason);
    // The runtime tracks every worker it starts; recovery refuses an untracked running attempt.
    const worker = await spawnWorker(dispatched.attempt);
    return { selection, dispatched, worker };
  }
  const limit = (
    attemptId: string,
    executor: "claude-code" | "codex",
    extra: Partial<ExecutionResult> = {},
  ): ExecutionResult => ({
    executionId: `exec-${attemptId}`,
    attemptId,
    executor,
    outcome: "usage-limit",
    exitCode: 1,
    signal: null,
    durationMs: 10,
    model: { requested: executor === "codex" ? "codex-model" : "opus-model" },
    effort: { requested: "high" },
    authMode: "subscription",
    toolsUsed: [],
    eventCount: 0,
    unparsedLines: 0,
    escalated: false,
    leftoverProcessesKilled: false,
    ...extra,
  });
  const failover = (
    capability: string,
    execution: ExecutionResult | undefined,
    extra: Record<string, unknown> = {},
  ) => {
    capabilityInUse.id = capability;
    return failoverStep(deps, {
      runId: "run-1",
      stepRunId: "step-1",
      capabilityProfile: capability,
      models,
      ...(execution === undefined ? {} : { execution }),
      ...extra,
    });
  };
  const retry = (failures = 1) => {
    const workflow = workflowSchema.parse({
      schema_version: 1,
      id: "feature",
      version: 1,
      selection: { task_types: ["feature"] },
      quality_policy: "strict",
      steps: [
        {
          id: "implement",
          role: "developer",
          needs: [],
          capability_profile: "coding",
          output_contract: "step-result",
        },
      ],
    });
    return retryStep(
      {
        dispatch: {
          ...dispatchDeps,
          runs,
          session,
          planner: {
            plan: () => {
              return Promise.reject(new Error("must reenter failover"));
            },
          },
          plans: {
            forRun: () => ({
              taskId: "t",
              projectId: "p",
              repository: "acme/app",
              issueNumber: 21,
              templateHash: "h",
            }),
          },
          workflows: {
            byId: () => ({ workflow, hash: "h" }),
            byHash: () => ({ workflow, hash: "h" }),
          },
          track: () => {},
        },
        rework: {
          runs: createSqliteReworkRunReader(db),
          session,
          nextId,
          checkpoint: () => ({ ok: false }),
        },
        operationalFailures: () => failures,
        retryBudget: deps.retryBudget,
        failover: {
          dependencies: deps,
          models: modelsConfigSchema.parse(models),
          effortPolicy: effortPolicySchema.parse(undefined),
          readTask: () =>
            Promise.resolve({
              complexity: taskComplexitySchema.parse(undefined),
              workspace: { taskId: "omi-018", slug: "failover" },
              context: {
                taskSnapshot: { issueNumber: 21, title: "Failover", body: "Fail over" },
                acceptanceCriteria: ["works"],
                businessBaselineHash: h("9"),
                inputArtifacts: [],
                previousFindings: [],
                allowedScope: { paths: ["src"] },
                approvalRefs: [],
              },
            }),
        },
      },
      { runId: "run-1", stepId: "implement" },
    );
  };
  const rework = () => createSqliteReworkRunReader(db).get("run-1");
  const profileState = (id: string) =>
    registry.list().find((entry) => entry.metadata.profileId === id)?.metadata;
  const stepStatus = () => runs.listSteps("run-1")[0]?.status;
  const spawnWorker = async (attempt: Parameters<typeof processes.track>[0]) => {
    const child = await startSupervisedProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: workspace.value.path,
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
    processes.track(attempt, child);
    return child;
  };
  return {
    r,
    root,
    clock,
    now,
    db: () => db,
    registry,
    selections,
    initial,
    checkpoint,
    start,
    limit,
    failover,
    retry,
    rework,
    profileState,
    stepStatus,
    spawnWorker,
    processes,
    deps,
  };
}

const CLAUDE_AB: readonly ProfileSpec[] = [
  { id: "claude-a", tool: "claude-code", preference: 0 },
  { id: "claude-b", tool: "claude-code", preference: 1 },
];
const COUNTER = {
  phase: "normal",
  failedCycles: 1,
  countedCycleIds: ["cycle-1"],
  reopenDecisionIds: [],
};

describe("failover from a checkpoint with fault injection (OMI-018)", () => {
  it("stops the writer, reconciles, picks another profile and starts a new attempt", async () => {
    const t = setup([...CLAUDE_AB, { id: "codex-1", tool: "codex", preference: 2 }]);
    const first = await t.start();
    expect(first.selection.candidate.profileId).toBe("claude-a");
    const worker = first.worker;
    const before = t.rework();
    const latest = t.deps.checkpoints.latestValid("run-1", new Date(t.now()).toISOString());

    const result = await t.failover("coding", t.limit("attempt-1", "claude-code"));

    expect(result).toMatchObject({ ok: true, outcome: "failed_over", profileId: "claude-b" });
    // Stop writer: the live worker was stopped by the runtime, its attempt interrupted.
    expect(() => process.kill(worker.pid, 0)).toThrow();
    expect(t.r.attempts.get("attempt-1")?.status).toBe("interrupted");
    // Profile cooldown, with the bounded backoff because no reset time was reported.
    expect(t.profileState("claude-a")).toMatchObject({
      state: "cooldown",
      cooldownUntil: t.now() + 500,
    });
    // New attempt on the other profile, resumed from the latest valid checkpoint.
    if (!result.ok || result.outcome !== "failed_over") throw new Error("not failed over");
    const next = t.r.attempts.get(result.attemptId);
    expect(next).toMatchObject({ attemptNumber: 2, status: "running" });
    expect(result.attemptId).not.toBe("attempt-1");
    expect(t.r.executor.started.map((request) => request.profileHome)).toEqual([
      "/profiles/claude-a",
      "/profiles/claude-b",
    ]);
    expect(latest?.record.id).toBe(t.initial.id);
    expect(t.r.executor.started[1]?.prompt).toContain(`${t.initial.id}.json`);
    expect(t.selections.settings(result.attemptId)?.chosen.profileId).toBe("claude-b");
    expect(t.stepStatus()).toBe("running");
    // The quality counter is exactly what it was; no rework event or run change happened.
    expect(t.rework()).toEqual(before);
    expect(t.rework()?.rework).toMatchObject(COUNTER);
    expect(
      t.db().prepare("SELECT count(*) AS n FROM events WHERE kind LIKE 'rework.%'").get(),
    ).toEqual({ n: 0 });
  });

  it("uses the reset time the tool reported for the cooldown", async () => {
    const t = setup(CLAUDE_AB);
    await t.start();
    const resetsAt = Math.floor(t.now() / 1000) + 7200;
    await t.failover("coding", t.limit("attempt-1", "claude-code", { quota: { resetsAt } }));
    expect(t.profileState("claude-a")?.cooldownUntil).toBe(resetsAt * 1000);
  });

  it("waits in waiting_resource when no other candidate exists, then continues", async () => {
    // Two profiles of one account share a quota: the limit cools both.
    const t = setup([
      { id: "claude-a", tool: "claude-code", group: "acct", preference: 0 },
      { id: "claude-b", tool: "claude-code", group: "acct", preference: 1 },
    ]);
    await t.start();
    const before = t.rework();
    const result = await t.failover("coding", t.limit("attempt-1", "claude-code"));
    expect(result).toMatchObject({
      ok: true,
      outcome: "waiting_resource",
      reason: "NO_MATCHING_COMBINATION",
    });
    expect(t.stepStatus()).toBe("waiting_resource");
    expect(t.r.executor.started).toHaveLength(1);
    expect(t.rework()).toEqual(before);
    // Nothing is left reserved: the only slot reservations belong to attempt-1 (interrupted).
    expect(
      t.db().prepare("SELECT count(*) AS n FROM agent_attempts WHERE status = 'pending'").get(),
    ).toEqual({ n: 0 });

    // The cooldown ends and a probe makes a profile ready again; the same entry point resumes.
    t.clock.ms += 600;
    // Only claude-a was written as cooling; claude-b was blocked through the shared account group.
    const limited = t.registry.list().find((entry) => entry.metadata.profileId === "claude-a");
    if (limited === undefined) throw new Error("profile missing");
    const recovered = Object.fromEntries(
      Object.entries(limited.metadata).filter(([key]) => key !== "cooldownUntil"),
    );
    t.registry.save(
      parseProfileMetadata({ ...recovered, state: "ready", lastProbeAt: t.now() }),
      t.now(),
      limited.revision,
    );
    const resumed = await t.retry();
    expect(resumed).toMatchObject({ ok: true, outcome: "failed_over", profileId: "claude-a" });
    expect(t.r.attempts.latestForStep("step-1")).toMatchObject({
      attemptNumber: 2,
      status: "running",
    });
    expect(t.rework()).toEqual(before);
  });

  describe("single Codex profile (PO rule 2026-11-11)", () => {
    const specs: readonly ProfileSpec[] = [
      { id: "codex-1", tool: "codex", preference: 0 },
      { id: "claude-a", tool: "claude-code", preference: 1 },
    ];

    it("a step that must run on Codex waits for Codex quota, not for Claude", async () => {
      const t = setup(specs);
      const first = await t.start("codex-only");
      expect(first.selection.candidate.profileId).toBe("codex-1");
      const result = await t.failover("codex-only", t.limit("attempt-1", "codex"), {
        requiredExecutor: "codex",
      });
      expect(result).toMatchObject({
        ok: true,
        outcome: "waiting_resource",
        reason: "NO_MATCHING_COMBINATION",
      });
      expect(JSON.stringify(result)).toContain("REQUIRED_EXECUTOR_MISMATCH");
      expect(t.stepStatus()).toBe("waiting_resource");
      expect(t.profileState("codex-1")?.state).toBe("cooldown");
      expect(t.profileState("claude-a")?.state).toBe("ready");
      // Claude was never started, and no pending reservation was left on it.
      expect(t.r.executor.started).toHaveLength(1);
      expect(
        t
          .db()
          .prepare("SELECT count(*) AS n FROM agent_attempts WHERE profile_id = 'claude-a'")
          .get(),
      ).toEqual({ n: 0 });
    });

    it("a step that does not require Codex fails over to a Claude profile", async () => {
      const t = setup(specs);
      const first = await t.start("coding");
      expect(first.selection.candidate.executor).toBe("codex");
      const result = await t.failover("coding", t.limit("attempt-1", "codex"));
      expect(result).toMatchObject({ ok: true, outcome: "failed_over", profileId: "claude-a" });
      expect(t.r.executor.started.at(-1)).toMatchObject({
        profileHome: "/profiles/claude-a",
        effort: "high",
      });
    });
  });

  describe("faults", () => {
    it("does not treat a login or network failure as a usage limit", async () => {
      const t = setup(CLAUDE_AB);
      await t.start();
      const result = await t.failover(
        "coding",
        t.limit("attempt-1", "claude-code", { outcome: "auth-required" }),
      );
      expect(result).toMatchObject({ ok: false, reason: "NOT_A_USAGE_LIMIT" });
      expect(t.stepStatus()).toBe("running");
      expect(t.profileState("claude-a")?.state).toBe("ready");
    });

    it("refuses a limit reported by an older attempt", async () => {
      const t = setup(CLAUDE_AB);
      await t.start();
      await t.failover("coding", t.limit("attempt-1", "claude-code"));
      // A late duplicate for attempt 1 must not fail over the running attempt 2 again.
      const late = await t.failover("coding", t.limit("attempt-1", "claude-code"));
      expect(late).toMatchObject({ ok: false, reason: "STALE_ATTEMPT" });
      expect(t.r.executor.started).toHaveLength(2);
    });

    it("keeps the step ready and frees the reservation when reconciliation fails", async () => {
      const t = setup(CLAUDE_AB);
      await t.start();
      // Damage the only checkpoint: there is nothing valid to continue from.
      fs.appendFileSync(join(t.root, t.initial.manifestPath), " ");
      const result = await t.failover("coding", t.limit("attempt-1", "claude-code"));
      expect(result).toMatchObject({
        ok: false,
        reason: "RESUME_REFUSED",
        detail: "CHECKPOINT_MISSING",
      });
      expect(t.r.executor.started).toHaveLength(1);
      expect(t.stepStatus()).toBe("ready");
      expect(
        t.db().prepare("SELECT count(*) AS n FROM agent_attempts WHERE status = 'pending'").get(),
      ).toEqual({ n: 0 });
      expect(t.rework()?.rework).toMatchObject(COUNTER);
    });

    it("stops failing over once the operational budget is spent", async () => {
      const t = setup(CLAUDE_AB);
      await t.start();
      const result = await t.failover("coding", t.limit("attempt-1", "claude-code"), {
        failoversMade: 3,
      });
      expect(result).toMatchObject({
        ok: true,
        outcome: "waiting_resource",
        reason: "RETRY_BUDGET_EXHAUSTED",
      });
      expect(t.stepStatus()).toBe("waiting_resource");
      expect(await t.retry(4)).toEqual({ ok: false, reason: "RETRY_BUDGET_EXHAUSTED" });
      expect(t.r.executor.started).toHaveLength(1);
      expect(t.rework()?.rework).toMatchObject(COUNTER);
    });
  });
});
