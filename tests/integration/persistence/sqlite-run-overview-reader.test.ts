import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openReadOnlyStateDatabase,
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteRunOverviewReader } from "../../../src/infrastructure/persistence/sqlite/sqlite-run-overview-reader.ts";

const at = "2026-11-12T09:00:00.000Z";
let directory: string;
let db: StateDatabase;

const addRun = (
  id: string,
  task: string,
  issue: number,
  extra = "",
  closed: string | null = null,
) => {
  db.prepare(
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES (?, 'p', ?, ?, 'h', ?, '{}', ?)",
  ).run(task, `I_${task}`, issue, at, at);
  db.exec(
    `INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, failure_count, created_at, updated_at, closed_at ${extra === "" ? "" : ", architect_intervention_id, counted_cycle_ids"})
     VALUES ('${id}', '${task}', 'hash-${id}', 'running', ${extra === "" ? "'normal', 0" : "'assisted', 1"}, '${at}', '${at}', ${closed === null ? "NULL" : `'${closed}'`}${extra === "" ? "" : ', \'arch-1\', \'["c1","c2","c3"]\''});`,
  );
};
const addStep = (id: string, run: string, key: string, status: string, iteration = 1) =>
  db
    .prepare(
      "INSERT INTO step_runs (id, run_id, step_key, iteration, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, run, key, iteration, status, at, at);
const addAttempt = (id: string, step: string, number: number, status: string, record?: unknown) =>
  db
    .prepare(
      `INSERT INTO agent_attempts (id, step_run_id, attempt_number, executor_id, model_id, profile_id, chosen_effort, status, dispatch_record, started_at)
       VALUES (?, ?, ?, 'codex', 'gpt-6.1-sol', 'codex-b', 'medium', ?, ?, ?)`,
    )
    .run(id, step, number, status, record === undefined ? null : JSON.stringify(record), at);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omi-run-overview-"));
  db = openStateDatabase(join(directory, "state.sqlite"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
  ).run(at, at);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

const reader = () => {
  const readOnly = openReadOnlyStateDatabase(join(directory, "state.sqlite"));
  return { reader: createSqliteRunOverviewReader(readOnly), close: () => readOnly.close() };
};

describe("createSqliteRunOverviewReader", () => {
  it("lists runs that are not closed, with the issue number and the pinned template", () => {
    addRun("run-open", "task-1", 164);
    addRun("run-closed", "task-2", 165, "", at);
    const { reader: overview, close } = reader();
    try {
      expect(overview.listActive()).toMatchObject([
        {
          runId: "run-open",
          taskId: "task-1",
          issueNumber: 164,
          status: "running",
          templateHash: "hash-run-open",
        },
      ]);
    } finally {
      close();
    }
  });

  it("carries the rework controller state", () => {
    addRun("run-1", "task-1", 164, "assisted");
    const { reader: overview, close } = reader();
    try {
      expect(overview.listActive()[0]?.rework).toEqual({
        phase: "assisted",
        failedCycles: 1,
        architectInterventionId: "arch-1",
        countedCycleIds: ["c1", "c2", "c3"],
        reopenDecisionIds: [],
      });
    } finally {
      close();
    }
  });

  it("gives the newest iteration of each step in creation order", () => {
    addRun("run-1", "task-1", 164);
    addStep("s-impl-1", "run-1", "implement", "failed", 1);
    addStep("s-verify", "run-1", "verify", "pending", 1);
    addStep("s-impl-2", "run-1", "implement", "running", 2);
    const { reader: overview, close } = reader();
    try {
      expect(overview.listActive()[0]?.steps).toEqual([
        { stepId: "verify", status: "pending" },
        { stepId: "implement", status: "running" },
      ]);
    } finally {
      close();
    }
  });

  it("gives the newest attempt of a step with who runs it and the skills and rules it got", () => {
    addRun("run-1", "task-1", 164);
    addStep("s-impl", "run-1", "implement", "running");
    addAttempt("att-1", "s-impl", 1, "failed");
    addAttempt("att-2", "s-impl", 2, "running", {
      role: { id: "developer", version: 1, sha256: "x" },
      skills: [{ id: "minimal-change", version: "1", sha256: "a" }],
      rules: [{ id: "project-baseline", version: "1", sha256: "b" }],
    });
    const { reader: overview, close } = reader();
    try {
      expect(overview.listActive()[0]?.attempts).toEqual([
        {
          stepId: "implement",
          attemptId: "att-2",
          status: "running",
          executor: "codex",
          profileId: "codex-b",
          model: "gpt-6.1-sol",
          effort: "medium",
          role: "developer",
          skills: ["minimal-change"],
          rules: ["project-baseline"],
          startedAt: at,
        },
      ]);
    } finally {
      close();
    }
  });

  it("shows a selector reservation that has no dispatch record yet without skills", () => {
    addRun("run-1", "task-1", 164);
    addStep("s-impl", "run-1", "implement", "ready");
    addAttempt("att-1", "s-impl", 1, "pending");
    const { reader: overview, close } = reader();
    try {
      expect(overview.listActive()[0]?.attempts[0]).toMatchObject({
        status: "pending",
        skills: [],
        rules: [],
      });
    } finally {
      close();
    }
  });

  it("refuses a dispatch record whose shape it does not know instead of guessing", () => {
    addRun("run-1", "task-1", 164);
    addStep("s-impl", "run-1", "implement", "running");
    addAttempt("att-1", "s-impl", 1, "running", { role: 5, skills: "x" });
    const { reader: overview, close } = reader();
    try {
      expect(() => overview.listActive()).toThrow();
    } finally {
      close();
    }
  });
});

describe("openReadOnlyStateDatabase", () => {
  it("cannot write, so the CLI never changes the runtime's state", () => {
    const readOnly = openReadOnlyStateDatabase(join(directory, "state.sqlite"));
    try {
      expect(() => readOnly.exec("UPDATE projects SET config_hash = 'x'")).toThrow(/readonly/i);
    } finally {
      readOnly.close();
    }
  });

  it("does not create a database that is not there", () => {
    expect(() => openReadOnlyStateDatabase(join(directory, "missing.sqlite"))).toThrow();
  });
});
