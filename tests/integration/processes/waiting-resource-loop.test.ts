import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { stringify } from "yaml";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectRunCommandUseCases } from "../../../src/bootstrap/container.ts";
import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";
import { requestApproval } from "../../../src/application/use-cases/approvals/request-approval.ts";
import { recordApproval } from "../../../src/application/use-cases/approvals/record-approval.ts";
import { createSqliteApprovalStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createSqliteProfileRegistry } from "../../../src/infrastructure/profiles/sqlite-profile-registry.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { startSessionRuntime } from "../../../src/infrastructure/processes/session-runtime.ts";
import { startSupervisedProcess } from "../../../src/infrastructure/processes/supervised-process.ts";
import { FakeGithub } from "../../contract/github/fake-github.ts";
import { FakeExecutor } from "../../unit/application/use-cases/runs/run-fakes.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "omi-resource-wake-"));
  const projectDir = join(directory, "project");
  const squad = join(projectDir, ".omi-squad");
  for (const path of ["config", "roles", "rules", "workflows", "provenance", "local/state"])
    mkdirSync(join(squad, path), { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "--initial-branch=develop");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(projectDir, ".gitignore"), ".omi-squad/local/\n");
  writeFileSync(
    join(squad, "config/project.yaml"),
    stringify({
      schema_version: 1,
      repository: { owner: "acme", name: "app" },
      project: { owner: "acme", number: 1 },
      branches: { integration: "develop", release: "main" },
      limits: { max_parallel_workers: 2, step_timeout_seconds: 60, max_rework_cycles: 2 },
      policies: { mandatory_approvals: [] },
      workspace: { worktree_root: join(directory, "worktrees") },
      resource_wait: { interval_ms: 10, max_backoff_ms: 40 },
    }),
  );
  writeFileSync(
    join(squad, "config/models.yaml"),
    stringify({
      schema_version: 1,
      models: {
        worker: { executor: "claude-code", model: "worker", supported_efforts: ["medium", "high"] },
      },
      capability_profiles: { standard: { min_effort: "medium" } },
      verified_models: { standard: ["worker"] },
    }),
  );
  for (const id of ["developer", "reviewer"])
    writeFileSync(
      join(squad, `roles/${id}.yaml`),
      stringify({
        schema_version: 1,
        id,
        version: 1,
        title: id,
        description: id,
        skills: [],
        rules: [],
      }),
    );
  writeFileSync(join(squad, "provenance/skills.lock.json"), JSON.stringify({ skills: [] }));
  copyFileSync(
    resolve("tests/fixtures/workflows/minimal-delivery.yaml"),
    join(squad, "workflows/minimal-delivery.yaml"),
  );
  git("add", ".");
  git("commit", "-m", "seed");
  const databasePath = join(squad, "local/state/state.sqlite");
  let db: StateDatabase = openStateDatabase(databasePath);
  applyMigrations(db, loadMigrations(resolve("migrations")));
  const clock = { ms: Date.parse("2026-11-11T00:00:00.000Z") };
  const now = () => clock.ms;
  const at = new Date(now()).toISOString();
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('task-144', 'p', 'I_144', 144, 'h', ?, '{}', ?)",
  ).run(at, at);
  const approvalDeps = {
    unitOfWork: createSqliteStateUnitOfWork(db),
    now,
    nextId: randomUUID,
    subjects: {
      read: () => ({
        kind: "business" as const,
        baselineHash: "9".repeat(64),
        scopeIds: ["task-144"],
      }),
    },
  };
  const requested = requestApproval(approvalDeps, {
    schemaVersion: 1,
    subjectId: "task-144",
    kind: "business",
  });
  if (!requested.ok) throw new Error(requested.reason);
  const decided = await recordApproval(
    {
      ...approvalDeps,
      store: createSqliteApprovalStore(db),
      allowedGitHubActors: [],
      source: {
        verify: (request) =>
          Promise.resolve({
            approvalId: request.id,
            version: request.version,
            subjectHash: request.subjectHash,
            decision: "approved",
            actor: "po",
            source: "po-cli",
            evidenceRef: "fixture",
          }),
      },
    },
    {
      schemaVersion: 1,
      approvalId: requested.request.id,
      expectedVersion: 0,
      decision: "approved",
      pathway: "cli",
    },
  );
  if (!decided.ok) throw new Error(decided.reason);
  const remote = new FakeGithub({ now });
  remote.issues.push({
    repo: "acme/app",
    number: 144,
    title: "Wake",
    body: "## Acceptance criteria\n- [ ] Wakes\n## Implementation map\n- `src/application/`\n<!-- omi-squad:plan-key=OMI-071 -->",
    createdAt: at,
  });
  const executor = new FakeExecutor();
  const probes: string[] = [];
  executor.probe = () => {
    probes.push("p1");
    return Promise.resolve({
      executor: "claude-code",
      status: "ready",
      compatibility: "supported",
      supportedRange: "fixture",
    });
  };
  const pending: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  const timer = {
    schedule(callback: () => void, ms: number) {
      const item = { callback, ms, cancelled: false };
      pending.push(item);
      return () => {
        item.cancelled = true;
      };
    },
  };
  let composition: Awaited<ReturnType<typeof createProjectRunCommandUseCases>>;
  let active: Awaited<ReturnType<typeof startSessionRuntime>>;
  let owner: PassThrough;
  let admissionStopped = false;
  async function start() {
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(db),
      state: createSqliteStateUnitOfWork(db),
      owner: randomUUID(),
      now,
      nextId: randomUUID,
      leaseMs: 60000,
    });
    composition = await createProjectRunCommandUseCases({
      projectDir,
      database: db,
      session,
      startProcess: startSupervisedProcess,
      transport: remote,
      executors: () => ({
        "claude-code": executor,
        codex: {
          executor: "codex",
          probe: () => Promise.reject(new Error("unexpected Codex probe")),
          start: () => Promise.reject(new Error("unexpected Codex start")),
          events: () => executor.events(),
          cancel: () => executor.cancel(),
          collectResult: (handle) => executor.collectResult(handle),
        },
      }),
      ...{ now },
    });
    owner = new PassThrough();
    active = await startSessionRuntime({
      session,
      owner: { channel: owner, heartbeatTimeoutMs: 60000, signals: [] },
      startAccepting: () => Promise.resolve(),
      stopAccepting: () => {
        admissionStopped = true;
        return Promise.resolve();
      },
      afterWorkersStopped: () => composition.drain(),
      ...{
        resourceWakeup: (canDispatch: () => boolean) => {
          const wakeup = composition.resourceWakeup?.(canDispatch);
          return wakeup === undefined ? undefined : { ...wakeup, timer, jitter: () => 0.999999 };
        },
      },
    });
    return composition;
  }
  const initial = await start();
  const plan = await initial.commands.planRun?.({
    issueNumber: 144,
    workflowId: "minimal-delivery",
  });
  const { runId } = z.object({ ok: z.literal(true), runId: z.string() }).parse(plan);
  db.prepare(
    "UPDATE step_runs SET status='waiting_resource' WHERE run_id=? AND step_key='implement'",
  ).run(runId);
  function observation(cooldownUntil = now() + 100) {
    createSqliteProfileRegistry(db).save(
      {
        profileId: "p1",
        tool: "claude-code",
        authMode: "subscription",
        credentialRef: join(directory, "profile"),
        accountGroupId: "account",
        modelAllowlist: ["worker"],
        state: "cooldown",
        cooldownUntil,
        lastProbeAt: now(),
        probeTtlMs: 60000,
        maxConcurrency: 1,
        accountGroupMaxConcurrency: 1,
        preference: 0,
      },
      now(),
    );
  }
  observation();
  async function stop() {
    if (!owner.writableEnded) owner.end("stop\n");
    await active.result;
  }
  cleanups.push(async () => {
    await stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const status = () =>
    composition.runs.listSteps(runId).find((step) => step.stepId === "implement")?.status;
  const flush = async () => {
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    await composition.drain();
  };
  return {
    executor,
    admissionStopped: () => admissionStopped,
    probes,
    pending,
    clock,
    observation,
    status,
    stop,
    flush,
    db: () => db,
    async tick() {
      const item = pending.find((entry) => !entry.cancelled);
      if (item !== undefined) {
        item.cancelled = true;
        clock.ms += item.ms;
        item.callback();
      }
      await flush();
    },
    async restart() {
      await stop();
      db.close();
      db = openStateDatabase(databasePath);
      await start();
    },
  };
}

describe("session resource wake-up loop", () => {
  it("probes an expired cooldown and re-dispatches through the persisted dispatch/completion path", async () => {
    const s = await setup();
    s.clock.ms += 100;
    await s.tick();
    expect(s.executor.started).toHaveLength(1);
    expect(s.probes).toEqual(["p1"]);
    // A missing worker result fails the attempt; the quality controller authorizes a retry.
    expect(s.status()).toBe("ready");
    const attempts = s.db().prepare("SELECT status, dispatch_record FROM agent_attempts").all();
    expect(attempts).toHaveLength(1);
    expect(
      z.object({ status: z.literal("failed"), dispatch_record: z.string() }).safeParse(attempts[0])
        .success,
    ).toBe(true);
  });
  it("stays waiting without probing an active account cooldown and backs off", async () => {
    const s = await setup();
    await s.tick();
    expect(s.status()).toBe("waiting_resource");
    expect(s.executor.started).toHaveLength(0);
    expect(s.probes).toHaveLength(0);
    expect(s.pending.filter((entry) => !entry.cancelled)[0]?.ms).toBeGreaterThan(10);
    expect(s.db().prepare("SELECT status FROM workflow_runs").get()).toEqual({ status: "running" });
    expect(s.db().prepare("SELECT count(*) AS n FROM agent_attempts").get()).toEqual({ n: 0 });
  });
  it("skips a cancelled waiting step even after the profile cooldown expires", async () => {
    const s = await setup();
    s.db().prepare("UPDATE step_runs SET status='cancelled' WHERE step_key='implement'").run();
    s.clock.ms += 100;
    await s.tick();
    expect(s.status()).toBe("cancelled");
    expect(s.executor.started).toHaveLength(0);
    expect(s.db().prepare("SELECT count(*) AS n FROM agent_attempts").get()).toEqual({ n: 0 });
    expect(s.pending.some((entry) => !entry.cancelled)).toBe(true);
  });
  it("finds persisted waiting steps after restart and never dispatches the same step twice", async () => {
    const s = await setup();
    await s.restart();
    // No valid completion has been recorded yet, as after an interrupted runtime.
    s.executor.outcome = "cancelled";
    s.clock.ms += 100;
    await s.tick();
    expect(s.executor.started).toHaveLength(1);
    expect(s.status()).toBe("running");
    await s.restart();
    await s.tick();
    expect(s.executor.started).toHaveLength(1);
    expect(s.status()).toBe("running");
    expect(
      s.db().prepare("SELECT count(*) AS n FROM events WHERE kind='step.dispatched'").get(),
    ).toEqual({ n: 1 });
  });

  it("does not dispatch a step cancelled while its profile probe is in flight", async () => {
    const s = await setup();
    s.executor.probe = () => {
      s.db().prepare("UPDATE step_runs SET status='cancelled' WHERE step_key='implement'").run();
      return Promise.resolve({
        executor: "claude-code",
        status: "ready",
        compatibility: "supported",
        supportedRange: "fixture",
      });
    };
    s.clock.ms += 100;
    await s.tick();
    expect(s.status()).toBe("cancelled");
    expect(s.executor.started).toHaveLength(0);
    expect(s.db().prepare("SELECT count(*) AS n FROM agent_attempts").get()).toEqual({ n: 0 });
  });

  it("drains a single in-flight pass on owner shutdown without starting a worker or rescheduling", async () => {
    const s = await setup();
    let release: () => void = () => undefined;
    const probe = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.executor.probe = async () => {
      s.probes.push("pending");
      await probe;
      return {
        executor: "claude-code",
        status: "ready",
        compatibility: "supported",
        supportedRange: "fixture",
      };
    };
    s.clock.ms += 100;
    await s.tick();
    expect(s.probes).toEqual(["pending"]);
    expect(s.pending.some((entry) => !entry.cancelled)).toBe(false);
    let stopped = false;
    const stopping = s.stop().then(() => {
      stopped = true;
    });
    await s.flush();
    expect(stopped).toBe(false);
    const admissionWasStopped = s.admissionStopped();
    release();
    await stopping;
    expect(admissionWasStopped).toBe(true);
    expect(s.executor.started).toHaveLength(0);
    expect(s.status()).toBe("waiting_resource");
    expect(createSqliteProfileRegistry(s.db()).list()[0]?.metadata.state).toBe("cooldown");
    expect(s.pending.some((entry) => !entry.cancelled)).toBe(false);
  });

  it("retains waiting state on probe failures with a bounded settings-based backoff", async () => {
    const s = await setup();
    s.executor.probe = () => Promise.reject(new Error("fixture probe unavailable"));
    s.clock.ms += 100;
    for (let pass = 0; pass < 8; pass += 1) {
      await s.tick();
      const delay = s.pending.find((entry) => !entry.cancelled)?.ms;
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(40);
      expect(s.status()).toBe("waiting_resource");
    }
    expect(s.executor.started).toHaveLength(0);
    expect(
      s
        .db()
        .prepare("SELECT count(*) AS n FROM events WHERE kind='profile.resource_probe_failed'")
        .get(),
    ).toEqual({ n: 8 });
  });
});
