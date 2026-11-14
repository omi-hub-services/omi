import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestApproval } from "../../../src/application/use-cases/approvals/request-approval.ts";
import { importTask } from "../../../src/application/use-cases/tasks/import-task.ts";
import { storeTaskSnapshots } from "../../../src/application/use-cases/tasks/store-task-snapshots.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  createSqliteApprovalStore,
  createSqliteTaskApprovalSubjects,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { issue, item, request } from "../../fixtures/github/task-import.ts";
import type { TaskIssue } from "../../../src/application/contracts/task-import.ts";

const hasher = { sha256: (text: string) => createHash("sha256").update(text).digest("hex") };
let dir: string;
let db: StateDatabase;
let clock = Date.UTC(2026, 10, 13);
let ids = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-task-snapshots-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('proj', 'acme/app', 'h', 't', 't')",
  ).run();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = () => ({
  hasher,
  now: () => (clock += 1000),
  nextId: () => `id-${String((ids += 1))}`,
  unitOfWork: createSqliteStateUnitOfWork(db),
  approvals: {
    store: createSqliteApprovalStore(db),
    subjects: createSqliteTaskApprovalSubjects(db),
  },
});
const imported = (value: TaskIssue = issue) =>
  importTask(
    {
      hasher,
      reader: {
        items: () => Promise.resolve([{ ...item, issueId: value.id }]),
        issue: () => Promise.resolve(value),
      },
    },
    { ...request, scope: { kind: "list", issueIds: [value.id] } },
  );
const rows = () => db.prepare("SELECT * FROM task_snapshots").all();
const events = () =>
  db.prepare("SELECT kind, subject, payload FROM events").all() as { kind: string }[];

describe("task snapshot persistence", () => {
  it("stores the import, keeps a rerun idempotent and lets a business request pin content_hash", async () => {
    const first = storeTaskSnapshots(deps(), {
      projectId: "proj",
      imported: await imported(),
    });
    expect(first).toMatchObject({ ok: true, snapshots: [{ taskId: "task-1", outcome: "stored" }] });
    const [snapshot] = (await imported()).snapshots;
    expect(rows()).toEqual([
      expect.objectContaining({
        id: "task-1",
        project_id: "proj",
        issue_node_id: "I_1",
        issue_number: 1,
        content_hash: snapshot?.contentHash,
        remote_updated_at: issue.updatedAt,
      }),
    ]);
    expect(events()).toHaveLength(1);

    const again = storeTaskSnapshots(deps(), {
      projectId: "proj",
      imported: await imported(),
    });
    expect(again).toMatchObject({
      ok: true,
      snapshots: [{ taskId: "task-1", outcome: "unchanged" }],
    });
    expect(rows()).toHaveLength(1);
    expect(events()).toHaveLength(1);

    const approval = requestApproval(
      { ...deps(), subjects: createSqliteTaskApprovalSubjects(db) },
      { schemaVersion: 1, subjectId: "task-1", kind: "business" },
    );
    expect(approval).toMatchObject({
      ok: true,
      request: { subjectHash: snapshot?.contentHash, status: "pending", version: 0 },
    });
  });

  it("updates changed Issue content, so the new revision hash differs from the old approval", async () => {
    storeTaskSnapshots(deps(), { projectId: "proj", imported: await imported() });
    const before = rows();
    const changed = storeTaskSnapshots(deps(), {
      projectId: "proj",
      imported: await imported({ ...issue, body: "Objective changed." }),
    });
    expect(changed).toMatchObject({
      ok: true,
      snapshots: [{ taskId: "task-1", outcome: "stored" }],
    });
    expect(rows()).toHaveLength(1);
    expect(rows()).not.toEqual(before);
    expect(events().map((e) => e.kind)).toEqual(["task.imported", "task.imported"]);
  });

  it("invalidates a business approval whose hash a re-import changed, keeping the decision for audit", async () => {
    storeTaskSnapshots(deps(), { projectId: "proj", imported: await imported() });
    const pending = requestApproval(
      { ...deps(), subjects: createSqliteTaskApprovalSubjects(db) },
      { schemaVersion: 1, subjectId: "task-1", kind: "business" },
    );
    if (!pending.ok) throw new Error("request refused");
    const store = createSqliteApprovalStore(db);
    const approved = {
      ...pending.request,
      status: "approved" as const,
      version: 1,
      decision: {
        id: pending.request.id,
        subject: pending.request.subject,
        decision: "approved" as const,
        actor: "po",
        source: "po-cli" as const,
        evidenceRef: "message",
        decidedAt: clock,
      },
    };
    const committed = createSqliteStateUnitOfWork(db).commit({
      target: { kind: "approval_decision", request: approved, expectedVersion: 0 },
      at: new Date(clock).toISOString(),
      event: {
        eventId: "approve-1",
        kind: "approval.approved",
        subject: approved.id,
        correlationId: approved.id,
        payload: JSON.stringify(approved),
      },
    });
    expect(committed.ok).toBe(true);

    // Same content again: the approval stays valid.
    storeTaskSnapshots(deps(), { projectId: "proj", imported: await imported() });
    expect(store.get(approved.id)?.status).toBe("approved");

    storeTaskSnapshots(deps(), {
      projectId: "proj",
      imported: await imported({ ...issue, body: "Objective changed." }),
    });
    expect(store.get(approved.id)).toMatchObject({
      status: "invalidated",
      version: 2,
      decision: { actor: "po", decision: "approved" },
    });
    expect(store.list("invalidated").map((r) => r.id)).toEqual([approved.id]);
    expect(store.list("approved")).toEqual([]);
    expect(events().map((e) => e.kind)).toContain("approval.invalidated");
  });

  it("rejects an Issue number already held by another Issue and writes nothing", async () => {
    storeTaskSnapshots(deps(), { projectId: "proj", imported: await imported() });
    const result = storeTaskSnapshots(deps(), {
      projectId: "proj",
      imported: await imported({ ...issue, id: "I_other" }),
    });
    expect(result).toEqual({ ok: false, reason: "ISSUE_NUMBER_CONFLICT", issueNodeId: "I_other" });
    expect(rows()).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });

  it("refuses an unknown project instead of creating one", async () => {
    expect(storeTaskSnapshots(deps(), { projectId: "nope", imported: await imported() })).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(rows()).toEqual([]);
  });
});
