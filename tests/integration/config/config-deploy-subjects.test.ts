import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeApprovalSubjects } from "../../../src/application/services/compose-approval-subjects.ts";
import { requestApproval } from "../../../src/application/use-cases/approvals/request-approval.ts";
import { recordApproval } from "../../../src/application/use-cases/approvals/record-approval.ts";
import { approvalSubjectHash } from "../../../src/domain/approvals/approval.ts";
import { createConfigDeploySubjects } from "../../../src/infrastructure/config/config-deploy-subjects.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteApprovalStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const target = (artifact_digest: string, environment = "sandbox") => ({
  id: "sandbox-r1",
  target_environment: environment,
  artifact_digest,
});

describe("config deploy subjects", () => {
  it("returns the configured target as a deploy subject", () => {
    expect(createConfigDeploySubjects([target(A)]).read("sandbox-r1", "deploy")).toEqual({
      kind: "deploy",
      artifactDigest: A,
      environment: "sandbox",
    });
  });

  it("returns nothing for an unknown id or a kind it does not own", () => {
    const subjects = createConfigDeploySubjects([target(A)]);
    expect(subjects.read("missing", "deploy")).toBeUndefined();
    expect(subjects.read("sandbox-r1", "business")).toBeUndefined();
  });

  it("fails closed on a duplicate id even if the schema check was bypassed", () => {
    const subjects = createConfigDeploySubjects([target(A), target(B)]);
    expect(subjects.read("sandbox-r1", "deploy")).toBeUndefined();
  });

  it("changes the subject hash when the digest or the environment changes", () => {
    const hash = (digest: string, environment?: string) => {
      const subject = createConfigDeploySubjects([target(digest, environment)]).read(
        "sandbox-r1",
        "deploy",
      );
      if (subject === undefined) throw new Error("missing subject");
      return approvalSubjectHash(subject);
    };
    expect(hash(A)).not.toBe(hash(B));
    expect(hash(A)).not.toBe(hash(A, "staging"));
  });
});

describe("deploy approval requests", () => {
  let dir: string;
  let db: StateDatabase;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omi-deploy-subjects-"));
    db = openStateDatabase(join(dir, "state.db"));
    applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pins the configured digest, and a changed digest makes the old request stale", async () => {
    let ids = 0;
    const shared = {
      unitOfWork: createSqliteStateUnitOfWork(db),
      now: () => Date.UTC(2026, 10, 13) + ids * 1000,
      nextId: () => `id-${String((ids += 1))}`,
    };
    const subjectsFor = (digest: string) =>
      composeApprovalSubjects({ deploy: createConfigDeploySubjects([target(digest)]) });
    const requested = requestApproval(
      { ...shared, subjects: subjectsFor(A) },
      { schemaVersion: 1, subjectId: "sandbox-r1", kind: "deploy" },
    );
    if (!requested.ok) throw new Error(requested.reason);
    expect(requested.request).toMatchObject({
      status: "pending",
      version: 0,
      subject: { kind: "deploy", artifactDigest: A, environment: "sandbox" },
    });

    // Caller input cannot choose the digest: the request schema has no such field.
    expect(
      requestApproval(
        { ...shared, subjects: subjectsFor(A) },
        { schemaVersion: 1, subjectId: "sandbox-r1", kind: "deploy", artifactDigest: B },
      ),
    ).toEqual({ ok: false, reason: "INVALID_INPUT" });

    const next = requestApproval(
      { ...shared, subjects: subjectsFor(B) },
      { schemaVersion: 1, subjectId: "sandbox-r1", kind: "deploy" },
    );
    if (!next.ok) throw new Error(next.reason);
    expect(next.request.subjectHash).not.toBe(requested.request.subjectHash);

    // The release moved to digest B: a decision on the old request is refused as stale.
    const decided = await recordApproval(
      {
        ...shared,
        subjects: subjectsFor(B),
        store: createSqliteApprovalStore(db),
        allowedGitHubActors: [],
        source: {
          verify: (request, command) =>
            Promise.resolve({
              approvalId: request.id,
              subjectHash: request.subjectHash,
              version: request.version,
              decision: command.decision,
              actor: "po",
              source: "po-cli" as const,
              evidenceRef: "terminal-confirmation",
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
    expect(decided).toEqual({ ok: false, reason: "STALE_REVISION" });
    expect(db.prepare("SELECT status FROM approvals WHERE id=?").get(requested.request.id)).toEqual(
      {
        status: "invalidated",
      },
    );
  });
});
