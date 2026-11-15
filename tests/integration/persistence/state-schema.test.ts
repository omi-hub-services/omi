import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { runInTransaction } from "../../../src/infrastructure/persistence/sqlite/sqlite-transaction.ts";

const MIGRATIONS = resolve(import.meta.dirname, "../../../migrations");
const T = "2026-11-10T00:00:00.000Z";

const ARCHITECTURE_TABLES = [
  "agent_attempts",
  "approvals",
  "artifacts",
  "checkpoints",
  "events",
  "github_mappings",
  "leases",
  "outbox",
  "profile_observations",
  "projects",
  "step_runs",
  "task_dependencies",
  "task_snapshots",
  "workflow_runs",
];

let dir: string;
let dbPath: string;
let db: StateDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-state-"));
  dbPath = join(dir, "state.db");
  db = openStateDatabase(dbPath);
  applyMigrations(db, loadMigrations(MIGRATIONS));
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertProject(id = "p1", repo = "acme/app"): void {
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES (?, ?, 'h', ?, ?)",
  ).run(id, repo, T, T);
}

function insertTask(id = "t1", number = 1, project = "p1"): void {
  db.prepare(
    `INSERT INTO task_snapshots
       (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at)
     VALUES (?, ?, ?, ?, 'h', ?, '{}', ?)`,
  ).run(id, project, `I_${id}`, number, T, T);
}

function insertRun(id: string, task = "t1", closedAt: string | null = null): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at, closed_at)
     VALUES (?, ?, 'h', 'running', 'implementation', ?, ?, ?)`,
  ).run(id, task, T, T, closedAt);
}

function insertEvent(eventId: string, runId: string | null = null): void {
  db.prepare(
    `INSERT INTO events (event_id, kind, subject, run_id, correlation_id, payload, occurred_at)
     VALUES (?, 'run.started', 'run', ?, 'c1', '{}', ?)`,
  ).run(eventId, runId, T);
}

describe("state database connection", () => {
  it("sets foreign_keys, WAL, synchronous FULL and a finite busy timeout", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(DEFAULT_BUSY_TIMEOUT_MS);
  });

  it("applies a configured busy timeout and rejects an unbounded or invalid one", () => {
    db.close();
    db = openStateDatabase(dbPath, { busyTimeoutMs: 250 });
    expect(db.pragma("busy_timeout", { simple: true })).toBe(250);
    for (const busyTimeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => openStateDatabase(dbPath, { busyTimeoutMs })).toThrow(RangeError);
    }
    expect(() => openStateDatabase(":memory:")).toThrow(RangeError);
  });

  it("keeps committed data across close and reopen", () => {
    insertProject();
    insertTask();
    insertRun("r1");
    insertEvent("e1", "r1");
    db.close();

    db = openStateDatabase(dbPath);
    expect(applyMigrations(db, loadMigrations(MIGRATIONS)).applied).toEqual([]);
    expect(db.prepare("SELECT id FROM workflow_runs").all()).toEqual([{ id: "r1" }]);
    expect(db.prepare("SELECT sequence, event_id FROM events").all()).toEqual([
      { sequence: 1, event_id: "e1" },
    ]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("transactions", () => {
  it("roll back every write when the work throws", () => {
    insertProject();
    insertTask();
    expect(() =>
      runInTransaction(db, () => {
        insertRun("r1");
        insertEvent("e1", "r1");
        db.prepare(
          `INSERT INTO outbox (operation_key, kind, subject, payload_ref, payload_hash, state, created_at, updated_at)
           VALUES ('op-1', 'create-pr', 'r1', 'ref', 'h', 'pending', ?, ?)`,
        ).run(T, T);
        throw new Error("agent result rejected");
      }),
    ).toThrow("agent result rejected");
    for (const table of ["workflow_runs", "events", "outbox"]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it("roll back when a constraint fails mid-transaction and survive a restart", () => {
    insertProject();
    insertTask();
    expect(() => {
      runInTransaction(db, () => {
        insertRun("r1");
        insertRun("r2"); // second active run for the same task
      });
    }).toThrow(/UNIQUE constraint failed/);
    db.close();
    db = openStateDatabase(dbPath);
    expect(db.prepare("SELECT count(*) AS n FROM workflow_runs").get()).toEqual({ n: 0 });
  });

  it("commit and return the result of synchronous work", () => {
    const id = runInTransaction(db, () => {
      insertProject();
      return "p1";
    });
    expect(id).toBe("p1");
    expect(db.prepare("SELECT id FROM projects").all()).toEqual([{ id: "p1" }]);
  });

  it("rejects promise-like callbacks at compile time and preserves synchronous result types", () => {
    expectTypeOf<typeof runInTransaction>().not.toExtend<
      (db: StateDatabase, work: () => Promise<void>) => Promise<void>
    >();
    expectTypeOf<Parameters<typeof runInTransaction<Promise<void>>>[1]>().toEqualTypeOf<
      () => never
    >();
    expectTypeOf<Parameters<typeof runInTransaction<PromiseLike<string>>>[1]>().toEqualTypeOf<
      () => never
    >();
    expectTypeOf<Parameters<typeof runInTransaction<string | Promise<string>>>[1]>().toEqualTypeOf<
      () => never
    >();
    expectTypeOf(runInTransaction(db, () => "result")).toEqualTypeOf<string>();
    expectTypeOf<ReturnType<typeof runInTransaction<undefined>>>().toEqualTypeOf<undefined>();
  });

  it("refuses native async work before invocation so writes after await cannot commit", async () => {
    let entered = false;
    // Simulate an untyped caller; the public signature rejects this callback.
    const work: () => unknown = async () => {
      entered = true;
      insertProject("before", "acme/before");
      await Promise.resolve();
      insertProject("after", "acme/after");
    };
    expect(() => runInTransaction(db, work)).toThrow(/must be synchronous/);
    await Promise.resolve();
    expect(entered).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });

  it("rolls back synchronous writes when an untyped callback returns a promise-like", () => {
    const work: () => unknown = () => {
      insertProject();
      return Promise.resolve("unexpected");
    };
    expect(() => runInTransaction(db, work)).toThrow(/must be synchronous/);
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });
});

describe("initial state schema", () => {
  it("creates every table from architecture.md §8 as STRICT", () => {
    const tables = db
      .prepare(
        "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
      )
      .all() as { name: string; strict: number }[];
    expect(tables.map((t) => t.name)).toEqual(ARCHITECTURE_TABLES);
    expect(tables.every((t) => t.strict === 1)).toBe(true);
  });

  it("declares the foreign keys between state tables", () => {
    const edges = (from: string) =>
      (
        db.prepare(`SELECT "table", "from" FROM pragma_foreign_key_list(?)`).all(from) as {
          table: string;
          from: string;
        }[]
      ).map((fk) => `${fk.from}->${fk.table}`);
    expect(edges("task_snapshots")).toEqual(["project_id->projects"]);
    expect(edges("task_dependencies").sort()).toEqual([
      "predecessor_task_id->task_snapshots",
      "successor_task_id->task_snapshots",
    ]);
    expect(edges("workflow_runs").sort()).toEqual([
      "replaces_run_id->workflow_runs",
      "task_id->task_snapshots",
    ]);
    expect(edges("step_runs")).toEqual(["run_id->workflow_runs"]);
    expect(edges("agent_attempts")).toEqual(["step_run_id->step_runs"]);
    expect(edges("checkpoints").sort()).toEqual([
      "run_id->workflow_runs",
      "step_run_id->step_runs",
    ]);
    expect(edges("artifacts")).toEqual(["producer_attempt_id->agent_attempts"]);
    expect(edges("approvals")).toEqual(["run_id->workflow_runs"]);
    expect(edges("events")).toEqual(["run_id->workflow_runs"]);
    expect(edges("github_mappings")).toEqual(["project_id->projects"]);
  });

  it("rejects rows that point at a missing parent", () => {
    expect(() => {
      insertTask("t1", 1, "no-such-project");
    }).toThrow(/FOREIGN KEY constraint failed/);
    insertProject();
    expect(() => {
      insertRun("r1", "no-such-task");
    }).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => {
      insertEvent("e1", "no-such-run");
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("refuses to delete a parent that still has children", () => {
    insertProject();
    insertTask();
    expect(() => db.prepare("DELETE FROM projects WHERE id = 'p1'").run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("allows one active workflow run per task, and a replacement once the old run is closed", () => {
    insertProject();
    insertTask();
    insertRun("r1");
    expect(() => {
      insertRun("r2");
    }).toThrow(/UNIQUE constraint failed: workflow_runs.task_id/);
    db.prepare("UPDATE workflow_runs SET closed_at = ? WHERE id = 'r1'").run(T);
    insertRun("r2");
    insertRun("r0", "t1", T); // closed history rows do not conflict
    expect(db.prepare("SELECT count(*) AS n FROM workflow_runs").get()).toEqual({ n: 3 });
  });

  it("enforces one operation key per external action", () => {
    const insert = db.prepare(
      `INSERT INTO outbox (operation_key, kind, subject, payload_ref, payload_hash, state, created_at, updated_at)
       VALUES (?, 'create-pr', 's', 'ref', 'h', 'pending', ?, ?)`,
    );
    insert.run("create-pr:repo:t1:task/x:develop", T, T);
    expect(() => insert.run("create-pr:repo:t1:task/x:develop", T, T)).toThrow(
      /UNIQUE constraint failed: outbox.operation_key/,
    );
  });

  it("enforces one holder per lease resource", () => {
    const insert = db.prepare(
      "INSERT INTO leases (resource_key, owner, generation, acquired_at, expires_at) VALUES (?, ?, 1, ?, ?)",
    );
    insert.run("worktree:/w/omi-009", "runtime-a", T, T);
    expect(() => insert.run("worktree:/w/omi-009", "runtime-b", T, T)).toThrow(
      /UNIQUE constraint failed: leases.resource_key/,
    );
  });

  it("enforces task, mapping and step uniqueness", () => {
    insertProject();
    insertTask("t1", 7);
    expect(() => {
      insertTask("t2", 7);
    }).toThrow(/UNIQUE constraint failed/);
    insertProject("p2", "acme/other");
    insertTask("t3", 7, "p2"); // same issue number in another project is fine

    const mapping = db.prepare(
      "INSERT INTO github_mappings (project_id, entity_kind, logical_key, external_id) VALUES ('p1', 'pull_request', ?, ?)",
    );
    mapping.run("task:t1", "PR_1");
    expect(() => mapping.run("task:t1", "PR_2")).toThrow(/UNIQUE constraint failed/);
    expect(() => mapping.run("task:t9", "PR_1")).toThrow(/UNIQUE constraint failed/);

    insertRun("r1");
    const step = db.prepare(
      "INSERT INTO step_runs (id, run_id, step_key, iteration, status, created_at, updated_at) VALUES (?, 'r1', 'implement', ?, 'pending', ?, ?)",
    );
    step.run("s1", 1, T, T);
    expect(() => step.run("s2", 1, T, T)).toThrow(/UNIQUE constraint failed/);
    step.run("s3", 2, T, T); // rework iteration
  });

  it("rejects an unknown step status, a self-dependency and a bare PID", () => {
    insertProject();
    insertTask();
    insertRun("r1");
    expect(() =>
      db
        .prepare(
          "INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at) VALUES ('s1', 'r1', 'k', 'done', ?, ?)",
        )
        .run(T, T),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO task_dependencies (predecessor_task_id, successor_task_id, source, source_revision) VALUES ('t1', 't1', 'github', 'r')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    db.prepare(
      "INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at) VALUES ('s1', 'r1', 'k', 'running', ?, ?)",
    ).run(T, T);
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_attempts (id, step_run_id, attempt_number, executor_id, model_id, profile_id, status, process_pid, started_at)
           VALUES ('a1', 's1', 1, 'claude-code', 'm', 'prof', 'running', 4242, ?)`,
        )
        .run(T),
    ).toThrow(/CHECK constraint failed/);
  });

  it("keeps events append-only", () => {
    insertEvent("e1");
    expect(() => db.prepare("UPDATE events SET kind = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(() => {
      insertEvent("e1");
    }).toThrow(/UNIQUE constraint failed: events.event_id/);
  });

  it("rejects values of the wrong type (STRICT)", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO leases (resource_key, owner, generation, acquired_at, expires_at) VALUES ('k', 'o', 'one', ?, ?)",
        )
        .run(T, T),
    ).toThrow(/cannot store TEXT value in INTEGER column/);
  });
});
