import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectRunCommandUseCases } from "../../src/bootstrap/container.ts";
import type { QuotaReader } from "../../src/application/ports/quota-reader.ts";
import { claimProjectSession } from "../../src/application/services/claim-project-session.ts";
import { recordApproval } from "../../src/application/use-cases/approvals/record-approval.ts";
import { requestApproval } from "../../src/application/use-cases/approvals/request-approval.ts";
import type { QuotaReading } from "../../src/domain/profiles/quota-policy.ts";
import { createSqliteApprovalStore } from "../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteLeaseStore } from "../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createSqliteProfileRegistry } from "../../src/infrastructure/profiles/sqlite-profile-registry.ts";
import {
  startSupervisedProcess,
  type SupervisedProcess,
} from "../../src/infrastructure/processes/supervised-process.ts";
import { FakeGithub } from "../contract/github/fake-github.ts";
import { FakeExecutor } from "../unit/application/use-cases/runs/run-fakes.ts";

const HOUR = 3_600_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const reading = (usedFiveHour: number, resetsAt: number, now: number): QuotaReading => ({
  source: "claude-usage-api",
  observedAt: now,
  fiveHour: { usedPercent: usedFiveHour, resetsAt },
  sevenDay: { usedPercent: 10, resetsAt: now + 48 * HOUR },
  status: "allowed",
  limited: false,
  resetCredits: null,
  modelWindows: [],
});

/** Real SQLite state, real planner and selection, real dispatch; only executors and quota are fake. */
async function setup(
  usedByProfile: Record<string, number>,
  { resetInMs = 30 * 60_000, limitFirstAttempt = false } = {},
) {
  const workers: SupervisedProcess[] = [];
  const directory = mkdtempSync(join(tmpdir(), "omi-quota-e2e-"));
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
      quota: { min_five_hour_left_percent: 10 },
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
  const db: StateDatabase = openStateDatabase(join(squad, "local/state/state.sqlite"));
  applyMigrations(db, loadMigrations(resolve("migrations")));
  const now = () => clock.ms;
  const clock = { ms: Date.parse("2026-11-11T00:00:00.000Z") };
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
  const registry = createSqliteProfileRegistry(db);
  for (const [index, id] of Object.keys(usedByProfile).entries()) {
    registry.save(
      {
        profileId: id,
        tool: "claude-code",
        authMode: "subscription",
        credentialRef: join(directory, id),
        accountGroupId: id,
        modelAllowlist: ["worker"],
        state: "ready",
        lastProbeAt: now(),
        probeTtlMs: 3_600_000,
        maxConcurrency: 1,
        accountGroupMaxConcurrency: 1,
        preference: index,
      },
      now(),
    );
  }
  const remote = new FakeGithub({ now });
  remote.issues.push({
    repo: "acme/app",
    number: 144,
    title: "Quota",
    body: "## Acceptance criteria\n- [ ] Picks by quota\n## Implementation map\n- `src/application/`\n<!-- omi-squad:plan-key=OMI-078 -->",
    createdAt: at,
  });
  const executor = new FakeExecutor();
  const reads: string[] = [];
  const quotaReader: QuotaReader = {
    read: (profile) => {
      reads.push(profile.profileId);
      const used = usedByProfile[profile.profileId] ?? 0;
      return Promise.resolve({
        reading: reading(used, now() + resetInMs, now()),
        note: null,
      });
    },
  };
  const session = claimProjectSession({
    leases: createSqliteLeaseStore(db),
    state: createSqliteStateUnitOfWork(db),
    owner: randomUUID(),
    now,
    nextId: randomUUID,
    leaseMs: 60000,
  });
  const composition = await createProjectRunCommandUseCases({
    projectDir,
    database: db,
    session,
    startProcess: startSupervisedProcess,
    transport: remote,
    quotaReader,
    executors: (ports) => {
      if (limitFirstAttempt) {
        // Like the real adapters: every started worker is a supervised process the runtime
        // tracks, so failover can prove it stopped before it reserves another profile.
        const fakeStart = executor.start.bind(executor);
        executor.start = async (request) => {
          const handle = await fakeStart(request);
          const child = await ports.startProcess({
            executable: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            cwd: directory,
            env: {},
            stdin: "",
            onStdoutLine: () => undefined,
            timeoutMs: 20_000,
            graceMs: 30,
            maxStdoutChars: 100,
            maxLineChars: 100,
            maxStderrChars: 100,
          });
          workers.push(child);
          ports.onWorkerStarted(request.attemptId, child);
          return handle;
        };
        // Only the first attempt hits the limit; later ones are cancelled so the run stays quiet.
        const collect = executor.collectResult.bind(executor);
        let collected = 0;
        executor.collectResult = async (handle) => ({
          ...(await collect(handle)),
          outcome: (collected += 1) === 1 ? "usage-limit" : "cancelled",
        });
      }
      return {
        "claude-code": executor,
        codex: {
          executor: "codex",
          probe: () => Promise.reject(new Error("unexpected Codex probe")),
          start: () => Promise.reject(new Error("unexpected Codex start")),
          events: () => executor.events(),
          cancel: () => executor.cancel(),
          collectResult: (handle) => executor.collectResult(handle),
        },
      };
    },
    now,
  });
  cleanups.push(() => {
    for (const worker of workers) worker.cancel("SIGKILL", "group");
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const plan = await composition.commands.planRun?.({
    issueNumber: 144,
    workflowId: "minimal-delivery",
  });
  const { runId } = z.object({ ok: z.literal(true), runId: z.string() }).parse(plan);
  const dispatch = () => composition.commands.dispatchRunStep?.({ runId, stepId: "implement" });
  return { composition, executor, db, clock, directory, dispatch, reads, registry };
}

describe("quota-aware dispatch end to end", () => {
  it("starts the attempt on the profile with quota left, not the preferred exhausted one", async () => {
    const s = await setup({ p1: 97, p2: 20 });
    const result = await s.dispatch();
    expect(result).toMatchObject({ ok: true });
    expect(s.executor.started).toHaveLength(1);
    expect(s.executor.started[0]?.profileHome).toBe(join(s.directory, "p2"));
    expect(s.reads.sort()).toEqual(["p1", "p2"]);
  });

  it("refuses with the earliest reset and starts no attempt when every profile is below the threshold", async () => {
    const s = await setup({ p1: 97, p2: 98 }, { resetInMs: 30 * 60_000 });
    const result = await s.dispatch();
    const resetAt = new Date(s.clock.ms + 30 * 60_000).toISOString();
    expect(result).toEqual({
      ok: false,
      reason: "QUOTA_EXHAUSTED",
      detail: `earliest_reset=${resetAt}`,
    });
    expect(s.executor.started).toHaveLength(0);
    expect(s.db.prepare("SELECT count(*) AS n FROM agent_attempts").get()).toEqual({ n: 0 });
    expect(s.db.prepare("SELECT status FROM step_runs WHERE step_key='implement'").get()).toEqual({
      status: "ready",
    });
  });

  it("still fails over to another profile when a limit is hit mid-run", async () => {
    const s = await setup({ p1: 20, p2: 40 }, { limitFirstAttempt: true });
    expect(await s.dispatch()).toMatchObject({ ok: true });
    expect(s.executor.started[0]?.profileHome).toBe(join(s.directory, "p1"));
    await s.composition.drain();
    await s.composition.drain();
    expect(s.executor.started.map((request) => request.profileHome)).toEqual([
      join(s.directory, "p1"),
      join(s.directory, "p2"),
    ]);
    const states = Object.fromEntries(
      s.registry.list().map(({ metadata }) => [metadata.profileId, metadata.state]),
    );
    expect(states["p1"]).toBe("cooldown");
  });
});
