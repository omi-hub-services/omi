import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { claimProjectSession } from "../../src/application/services/claim-project-session.ts";
import { recordReworkEvent } from "../../src/application/use-cases/runs/record-rework-event.ts";
import { writeCheckpoint } from "../../src/application/use-cases/runs/write-checkpoint.ts";
import { dispatchStep } from "../../src/application/use-cases/runs/dispatch-step.ts";
import { recordStepResult } from "../../src/application/use-cases/runs/record-step-result.ts";
import { selectReadyTasks } from "../../src/application/use-cases/tasks/select-ready-tasks.ts";
import type { ReworkEvent, ReworkState } from "../../src/domain/runs/rework-policy.ts";
import { createLocalArtifactStore } from "../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createLocalCheckpointStore } from "../../src/infrastructure/artifacts/local-checkpoint-store.ts";
import { sha256ContentHasher } from "../../src/infrastructure/artifacts/sha256-content-hasher.ts";
import { createCliGitWorkspace } from "../../src/infrastructure/git/cli-git-workspace.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteLeaseStore } from "../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createSqliteReworkRunReader } from "../../src/infrastructure/persistence/sqlite/sqlite-rework-run-reader.ts";
import { createSqliteRecoveryRunReader } from "../../src/infrastructure/persistence/sqlite/sqlite-recovery-run-reader.ts";
import { issue, item, request } from "../fixtures/github/task-import.ts";
import { dispatchInput, h, rig } from "../unit/application/use-cases/runs/run-fakes.ts";

it("persists 2 + Architect + 2 across restart, excludes infrastructure, and runs an independent task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omi-rework-"));
  const path = join(directory, "state.db");
  let db = openStateDatabase(path);
  try {
    applyMigrations(db, loadMigrations(resolve("migrations")));
    const main = join(directory, "repo");
    const root = join(directory, "artifacts");
    mkdirSync(main);
    mkdirSync(root);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: main,
        stdio: "pipe",
      });
    git("init", "-q", "-b", "develop");
    git("config", "user.name", "Rework test");
    git("config", "user.email", "rework@example.invalid");
    writeFileSync(join(main, "tracked.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "seed");
    db.exec("INSERT INTO projects VALUES ('p','repo',NULL,'h','t','t')");
    for (const [index, id] of ["I_1", "I_2", "I_3"].entries()) {
      db.prepare(
        "INSERT INTO task_snapshots (id,project_id,issue_node_id,issue_number,content_hash,remote_updated_at,scope,captured_at) VALUES (?,'p',?,?,'h','t','{}','t')",
      ).run(id, id, index + 1);
      db.prepare(
        "INSERT INTO workflow_runs (id,task_id,template_hash,status,quality_phase,created_at,updated_at) VALUES (?,?,'h','running','normal','t','t')",
      ).run(`run-${id}`, id);
    }
    const r = rig();
    let sequence = 0;
    const nextId = () => `rework-${String(++sequence)}`;
    function wiring() {
      const leases = createSqliteLeaseStore(db);
      const session = claimProjectSession({
        leases,
        state: createSqliteStateUnitOfWork(db),
        owner: "coordinator",
        now: r.deps.now,
        nextId,
        leaseMs: 60_000,
      });
      const workspaces = createCliGitWorkspace({ mainWorktreePath: main }, leases);
      const checkpointDeps = {
        ...r.deps,
        nextId,
        workspaces,
        artifacts: createLocalArtifactStore(root, db),
        checkpoints: createLocalCheckpointStore(root, db),
        hasher: sha256ContentHasher,
      };
      return {
        runs: createSqliteReworkRunReader(db),
        session,
        nextId,
        checkpoint: (runId: string, state: ReworkState) => {
          const saved = writeCheckpoint(checkpointDeps, {
            runId,
            kind: "after-output",
            workspacePath: main,
            hashes: { config: h("a"), template: h("b") },
            taskSnapshot: { issueNumber: 1, title: "Quality failures", body: "Fix output" },
            acceptanceCriteria: ["checks and review pass"],
            businessBaselineHash: h("c"),
            counters: { failedCycles: state.failedCycles },
            decisions: [{ id: "failure-history", summary: JSON.stringify(state) }],
            nextAction: { action: "notify-po" },
          });
          return saved.ok
            ? { ok: true as const, checkpointId: saved.checkpoint.id }
            : { ok: false as const };
        },
      };
    }
    async function runWorker(
      runId: string,
      stepRunId: string,
      role = "developer",
      status: "succeeded" | "failed" = "succeeded",
    ) {
      const stepKey = role === "architect" ? "diagnose" : "implement";
      db.prepare(
        "INSERT INTO step_runs (id,run_id,step_key,iteration,status,version,created_at,updated_at) VALUES (?,?,?,(SELECT count(*) + 1 FROM step_runs WHERE run_id=?),'ready',1,'t','t')",
      ).run(stepRunId, runId, stepKey, runId);
      const recovery = createSqliteRecoveryRunReader(db);
      const workerDeps = {
        ...r.deps,
        nextId,
        catalog: {
          ...r.deps.catalog,
          roles: [
            ...r.deps.catalog.roles,
            {
              definition: {
                ...r.deps.catalog.roles[0]?.definition,
                schema_version: 1 as const,
                id: "architect",
                version: 1,
                title: "Architect",
                description: "Diagnoses root causes",
                skills: [],
                rules: [],
              },
              sha256: h("d"),
            },
          ],
        },
        steps: { get: (id: string) => recovery.listSteps(runId).find((step) => step.id === id) },
        unitOfWork: createSqliteStateUnitOfWork(db),
        workspaces: createCliGitWorkspace({ mainWorktreePath: main }, createSqliteLeaseStore(db)),
      };
      const dispatched = await dispatchStep(
        workerDeps,
        dispatchInput({
          stepRunId,
          role,
          taskId: runId === "run-I_1" ? "omi-001" : "omi-003",
          slug: runId === "run-I_1" ? "quality-task" : "independent",
          requiredChecks: [],
          execution: {
            profileHome: "/profiles/a",
            model: "opus",
            effort: "high",
            access: "read-only",
            timeoutMs: 60_000,
          },
        }),
      );
      if (!dispatched.ok) throw new Error(dispatched.reason);
      const execution = await r.executor.collectResult(dispatched.handle);
      expect(
        recordStepResult(workerDeps, {
          attemptId: dispatched.attempt.id,
          execution,
          result: {
            schemaVersion: 1,
            runId,
            stepId: stepKey,
            attemptId: dispatched.attempt.id,
            status,
            summary:
              role === "architect"
                ? "Root cause: inconsistent input assumptions; fix the validation boundary."
                : "Quality round evaluated",
            artifacts: [],
            checks: [],
            findings: [],
          },
        }),
      ).toMatchObject({ ok: true, stepStatus: status });
      return dispatched.attempt.id;
    }
    let deps = wiring();
    const record = (event: ReworkEvent) => recordReworkEvent(deps, { runId: "run-I_1", event });
    const failed = (cycleId: string): ReworkEvent => ({
      type: "cycle_failed",
      kind: "quality",
      cycleId,
    });
    await runWorker("run-I_1", "review-round-1", "developer", "failed");
    expect(record(failed("review-round-1"))).toMatchObject({
      action: "retry",
      state: { failedCycles: 1 },
    });
    expect(record(failed("review-round-1"))).toEqual({
      ok: false,
      reason: "CYCLE_ALREADY_COUNTED",
    });
    const before = deps.runs.get("run-I_1");
    for (const cycleId of ["worker-crash", "quota", "network"]) {
      expect(record({ type: "cycle_failed", kind: "infrastructure", cycleId })).toEqual({
        ok: false,
        reason: "INFRASTRUCTURE_FAILURE_NOT_QUALITY",
      });
    }
    expect(deps.runs.get("run-I_1")).toEqual(before);
    await runWorker("run-I_1", "check-round-2", "developer", "failed");
    expect(record(failed("check-round-2"))).toMatchObject({ action: "architect_required" });
    expect(record(failed("premature-retry"))).toMatchObject({ ok: false });
    // Coordinator consumes the escalation action, dispatches an Architect, and records its solution.
    const interventionId = await runWorker("run-I_1", "architect-step", "architect");
    expect(
      record({
        type: "architect_solution_accepted",
        interventionId,
        changesBusinessOrCost: false,
        approvalValid: false,
      }),
    ).toMatchObject({ action: "retry", state: { failedCycles: 0 } });
    deps.session.release();
    db.close();
    db = openStateDatabase(path);
    deps = wiring();
    expect(deps.runs.get("run-I_1")?.rework).toMatchObject({
      phase: "assisted",
      architectInterventionId: interventionId,
      countedCycleIds: ["review-round-1", "check-round-2"],
    });
    expect(record(failed("review-round-1"))).toMatchObject({ reason: "CYCLE_ALREADY_COUNTED" });
    await runWorker("run-I_1", "check-round-3", "developer", "failed");
    expect(record(failed("check-round-3"))).toMatchObject({
      action: "retry",
      state: { failedCycles: 1 },
    });
    expect(
      record({ type: "cycle_failed", kind: "infrastructure", cycleId: "quota-again" }),
    ).toMatchObject({ ok: false });
    await runWorker("run-I_1", "review-round-4", "developer", "failed");
    expect(record(failed("review-round-4"))).toMatchObject({
      action: "blocked",
      state: { phase: "blocked", failedCycles: 2 },
    });
    expect(deps.runs.get("run-I_1")?.status).toBe("blocked");
    expect(db.prepare("SELECT status FROM checkpoints").all()).toEqual([{ status: "valid" }]);
    expect(
      db.prepare("SELECT kind FROM events WHERE kind='rework.architect_required'").all(),
    ).toHaveLength(1);

    const ids = ["I_1", "I_2", "I_3"];
    const imported = {
      ...request,
      scope: { kind: "list", issueIds: ids },
      items: ids.map((id) => ({ ...item, id: `item-${id}`, issueId: id })),
      snapshots: ids.map((id, index) => ({
        schemaVersion: 1,
        contentHash: h("a"),
        issue: { ...issue, id, number: index + 1, blockedBy: id === "I_2" ? ["I_1"] : [] },
      })),
    };
    const selected = selectReadyTasks({
      imported,
      states: ids.map((id) => ({
        id,
        status: deps.runs.get(`run-${id}`)?.status === "blocked" ? "blocked" : "ready",
        priority: "P0",
      })),
      activeTaskIds: [],
      activeWorkers: 0,
    });
    expect(selected.map((snapshot) => snapshot.issue.id)).toEqual(["I_3"]);
    await runWorker("run-I_3", "independent-step");
    expect(deps.runs.get("run-I_1")?.status).toBe("blocked");
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
