import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { commandSchema } from "../../../src/application/contracts/command.ts";
import { requestApproval } from "../../../src/application/use-cases/approvals/request-approval.ts";
import { recordApproval } from "../../../src/application/use-cases/approvals/record-approval.ts";
import { recordReworkDecision } from "../../../src/application/use-cases/runs/record-rework-event.ts";
import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";
import { createCommandDispatcher } from "../../../src/interfaces/ipc/command-dispatcher.ts";
import { createGitHubApprovalDecisionSource } from "../../../src/infrastructure/github/github-approval-decision-source.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  createSqliteApprovalStore,
  createSqliteTaskApprovalSubjects,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteReworkRunReader } from "../../../src/infrastructure/persistence/sqlite/sqlite-rework-run-reader.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";

it.each(["cli", "github"] as const)(
  "reopens only after approval.decide authenticates the %s pathway",
  async (pathway) => {
    const directory = mkdtempSync(join(tmpdir(), "omi-retry-approval-"));
    const db = openStateDatabase(join(directory, "state.db"));
    try {
      applyMigrations(db, loadMigrations(resolve("migrations")));
      const at = "2026-11-13T00:00:00.000Z";
      const hash = "a".repeat(64);
      db.prepare(
        "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p','acme/app','h',?,?)",
      ).run(at, at);
      db.prepare(
        "INSERT INTO task_snapshots (id,project_id,issue_node_id,issue_number,content_hash,remote_updated_at,scope,captured_at) VALUES ('task','p','I_1',1,?,?,'{}',?)",
      ).run(hash, at, at);
      db.prepare(
        "INSERT INTO workflow_runs (id,task_id,template_hash,status,quality_phase,failure_count,counted_cycle_ids,created_at,updated_at) VALUES ('run','task','h','blocked','blocked',2,'[\"c1\",\"c2\",\"c3\",\"c4\"]',?,?)",
      ).run(at, at);
      let id = 0;
      const now = () => Date.parse(at);
      const nextId = () => `event-${String(++id)}`;
      const session = claimProjectSession({
        leases: createSqliteLeaseStore(db),
        state: createSqliteStateUnitOfWork(db),
        owner: "runtime",
        now,
        nextId,
        leaseMs: 60000,
      });
      const store = createSqliteApprovalStore(db);
      const subjects = createSqliteTaskApprovalSubjects(db);
      const shared = {
        store,
        subjects,
        now,
        nextId,
        unitOfWork: createSqliteStateUnitOfWork(db, session.lease),
      };
      const requested = requestApproval(shared, {
        schemaVersion: 1,
        subjectId: "task",
        kind: "business",
        runId: "run",
      });
      if (!requested.ok) throw new Error(requested.reason);
      const request = requested.request;
      const source = createGitHubApprovalDecisionSource({
        repository: "acme/app",
        confirmCli: (r, c) =>
          Promise.resolve({
            approvalId: r.id,
            subjectHash: r.subjectHash,
            version: r.version,
            decision: c.decision,
            actor: "po",
            source: "po-cli",
            evidenceRef: "terminal:test",
          }),
        readComment: () =>
          Promise.resolve({
            user: { login: "po", type: "User" },
            created_at: at,
            updated_at: at,
            body: JSON.stringify({
              schemaVersion: 1,
              approvalId: request.id,
              subjectHash: hash,
              version: 0,
              decision: "approved",
            }),
          }),
      });
      const rework = {
        runs: createSqliteReworkRunReader(db),
        session,
        nextId,
        checkpoint: () => ({ ok: false as const }),
        approvals: {
          store,
          subjects,
          now,
          allowedGitHubActors: ["po"],
          authorActor: () => Promise.resolve("worker"),
        },
      };
      const handler = createCommandDispatcher({
        inspectRuntime: () => {
          throw new Error("unused");
        },
        recordApproval: (input) =>
          recordApproval({ ...shared, source, allowedGitHubActors: ["po"] }, input),
        recordReworkEvent: (input) => recordReworkDecision(rework, input),
      });
      const reopen = commandSchema.parse({
        schemaVersion: 1,
        command: "rework.record",
        runId: "run",
        event: { type: "po_reopened", poDecisionId: request.id },
      });
      expect(await handler(reopen)).toMatchObject({
        ok: false,
        error: { message: "APPROVAL_NOT_ACTIVE" },
      });
      expect(rework.runs.get("run")?.status).toBe("blocked");
      expect(
        await handler(
          commandSchema.parse({
            schemaVersion: 1,
            command: "approval.decide",
            approvalId: request.id,
            expectedVersion: 0,
            decision: "approved",
            pathway,
            ...(pathway === "github" ? { evidenceRef: "123" } : {}),
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(await handler(reopen)).toMatchObject({ ok: true, result: { action: "retry" } });
      expect(rework.runs.get("run")).toMatchObject({
        status: "running",
        rework: { countedCycleIds: ["c1", "c2", "c3", "c4"], reopenDecisionIds: [request.id] },
      });
      expect(
        db.prepare("SELECT count(*) AS n FROM events WHERE kind='approval.approved'").get(),
      ).toEqual({ n: 1 });
      session.release();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
