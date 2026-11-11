import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { selectReadyTasks } from "../../src/application/use-cases/tasks/select-ready-tasks.ts";
import { selectExecutor } from "../../src/application/use-cases/profiles/select-executor.ts";
import { dispatchStep } from "../../src/application/use-cases/runs/dispatch-step.ts";
import { createCliGitWorkspace } from "../../src/infrastructure/git/cli-git-workspace.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteLeaseStore } from "../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createSqliteProfileRegistry } from "../../src/infrastructure/profiles/sqlite-profile-registry.ts";
import { createSqliteExecutorSelectionStore } from "../../src/infrastructure/profiles/sqlite-executor-selection-store.ts";
import { issue, item, request } from "../fixtures/github/task-import.ts";
import { dispatchInput, rig } from "../unit/application/use-cases/runs/run-fakes.ts";

const models = {
  schema_version: 1,
  models: {
    tested: { executor: "claude-code", model: "tested-model", supported_efforts: ["high"] },
  },
  capability_profiles: { coding: { min_effort: "high" } },
  verified_models: { coding: ["tested"] },
};

describe("bounded DAG scheduler with sandbox worktrees and fake executors", () => {
  it("runs two independent tasks together and refuses a second writer using the shared SQLite lease", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omi-scheduler-"));
    const db = openStateDatabase(join(directory, "state.sqlite"));
    try {
      applyMigrations(db, loadMigrations(resolve("migrations")));
      const main = join(directory, "repo");
      mkdirSync(main);
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
          cwd: main,
          stdio: "pipe",
        });
      git("init", "-q", "-b", "develop");
      git("config", "user.name", "Scheduler test");
      git("config", "user.email", "scheduler@example.invalid");
      writeFileSync(join(main, "tracked.txt"), "initial\n");
      git("add", ".");
      git("commit", "-qm", "initial");
      const workspaces = createCliGitWorkspace(
        { mainWorktreePath: main },
        createSqliteLeaseStore(db),
      );
      const runtime = rig();
      const now = runtime.deps.now();
      const registry = createSqliteProfileRegistry(db);
      for (const profileId of ["a", "b"])
        registry.save(
          {
            profileId,
            tool: "claude-code",
            authMode: "subscription",
            credentialRef: `/profiles/${profileId}`,
            accountGroupId: profileId,
            modelAllowlist: ["tested-model"],
            state: "ready",
            lastProbeAt: now,
            probeTtlMs: 60_000,
            maxConcurrency: 1,
            accountGroupMaxConcurrency: 1,
            preference: 1,
          },
          now,
        );
      const store = createSqliteExecutorSelectionStore(db, registry);
      db.exec("INSERT INTO projects VALUES ('p','repo',NULL,'h','t','t')");
      const ids = ["I_1", "I_2", "I_3"];
      for (const [index, id] of ids.entries()) {
        db.prepare(
          "INSERT INTO task_snapshots (id,project_id,issue_node_id,issue_number,content_hash,remote_updated_at,scope,captured_at) VALUES (?,'p',?,?,'h','t','{}','t')",
        ).run(id, id, index + 1);
        db.prepare(
          "INSERT INTO workflow_runs (id,task_id,template_hash,status,quality_phase,created_at,updated_at) VALUES (?,?,'h','running','implementation','t','t')",
        ).run(`run-${id}`, id);
        db.prepare(
          "INSERT INTO step_runs (id,run_id,step_key,status,version,created_at,updated_at) VALUES (?,?,'implement','ready',1,'t','t')",
        ).run(`step-${id}`, `run-${id}`);
        runtime.steps.rows.set(`step-${id}`, {
          id: `step-${id}`,
          runId: `run-${id}`,
          stepId: "implement",
          status: "ready",
          version: 1,
        });
      }
      const imported = {
        ...request,
        scope: { kind: "list", issueIds: ids },
        items: ids.map((id) => ({ ...item, id: `item-${id}`, issueId: id })),
        snapshots: ids.map((id, index) => ({
          schemaVersion: 1,
          contentHash: "a".repeat(64),
          issue: { ...issue, id, number: index + 1 },
        })),
      };
      const states = ids.map((id) => ({ id, status: "ready", priority: "P0" }));
      const selected = selectReadyTasks({ imported, states, activeTaskIds: [], activeWorkers: 0 });
      expect(selected.map((snapshot) => snapshot.issue.id)).toEqual(["I_1", "I_2"]);

      // Keep executor.start pending until both tasks enter it. A serialized dispatch cannot
      // reach this barrier: this proves overlap without relying on timing or sleep.
      let releaseStarts = () => {};
      const barrier = new Promise<void>((resolveBarrier) => {
        releaseStarts = resolveBarrier;
      });
      const originalStart = runtime.executor.start.bind(runtime.executor);
      runtime.executor.start = async (input) => {
        const handle = await originalStart(input);
        if (runtime.executor.started.length === 2) releaseStarts();
        await barrier;
        return handle;
      };
      const deps = { ...runtime.deps, workspaces, unitOfWork: createSqliteStateUnitOfWork(db) };
      const commands = selected.map(({ issue: task }, index) => {
        const selection = selectExecutor(store, {
          attemptId: `reservation-${task.id}`,
          stepRunId: `step-${task.id}`,
          attemptNumber: 1,
          capabilityProfile: "coding",
          now,
          models,
        });
        if (selection.outcome !== "selected") throw new Error("expected profile capacity");
        return dispatchInput({
          taskId: `omi-00${String(index + 1)}`,
          slug: `task-${String(index + 1)}`,
          stepRunId: `step-${task.id}`,
          owner: `writer-${String(index + 1)}`,
          execution: {
            profileHome: `/profiles/${selection.candidate.profileId}`,
            model: selection.candidate.model,
            effort: selection.effort,
            access: "workspace-write",
            timeoutMs: 60_000,
          },
        });
      });
      const results = await Promise.all(commands.map((command) => dispatchStep(deps, command)));
      expect(results.every((result) => result.ok)).toBe(true);
      expect(runtime.executor.started).toHaveLength(2);
      expect(new Set(runtime.executor.started.map((entry) => entry.workspace)).size).toBe(2);
      expect(new Set(runtime.executor.started.map((entry) => entry.profileHome)).size).toBe(2);
      expect([...runtime.attempts.rows.values()].map((entry) => entry.status)).toEqual([
        "running",
        "running",
      ]);
      expect(
        selectReadyTasks({ imported, states, activeTaskIds: ["I_1", "I_2"], activeWorkers: 2 }),
      ).toEqual([]);
      expect(
        selectExecutor(store, {
          attemptId: "third-reservation",
          stepRunId: "step-I_3",
          attemptNumber: 1,
          capabilityProfile: "coding",
          now,
          models,
        }).outcome,
      ).toBe("waiting_resource");

      // A fresh step targeting the first task's existing worktree must not reach the executor.
      const secondWriter = await dispatchStep(deps, {
        ...commands[0],
        stepRunId: "step-I_3",
        owner: "second-writer",
      });
      expect(secondWriter).toMatchObject({
        ok: false,
        reason: "WORKSPACE_UNAVAILABLE",
        detail: "WRITER_HELD",
      });
      expect(runtime.executor.started).toHaveLength(2);
      const first = results[0];
      if (first === undefined || !first.ok) throw new Error("first writer missing");
      expect(
        db
          .prepare("SELECT owner FROM leases WHERE resource_key = ?")
          .get(first.attempt.workspace.leaseKey),
      ).toEqual({ owner: "writer-1" });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
