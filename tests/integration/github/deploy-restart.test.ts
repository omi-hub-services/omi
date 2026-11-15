import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { deployRelease } from "../../../src/application/use-cases/delivery/deploy-release.ts";
import { approvalSubjectHash } from "../../../src/domain/approvals/approval.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createGithubDeployReader } from "../../../src/infrastructure/github/github-deploy.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { FakeGithub } from "../../contract/github/fake-github.ts";

it("recovers an interrupted in-flight dispatch from SQLite after reopening the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-deploy-"));
  mkdirSync(join(dir, "artifacts"));
  const fake = new FakeGithub();
  fake.tags.set("acme/sandbox:pipeline-1", "b".repeat(40));
  const dbPath = join(dir, "state.db");
  let db = openStateDatabase(dbPath);
  const subject = {
    kind: "deploy" as const,
    artifactDigest: `sha256:${"a".repeat(64)}`,
    environment: "sandbox",
  };
  const client = () =>
    createGithubRestClient({
      transport: fake,
      now: Date.now,
      random: () => 0,
      sleep: () => Promise.resolve(),
    });
  function wire() {
    applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
    const rest = client();
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(db),
      state: createSqliteStateUnitOfWork(db),
      owner: "deploy-test",
      now: Date.now,
      nextId: randomUUID,
      leaseMs: 60000,
    });
    return {
      session,
      artifacts: createLocalArtifactStore(join(dir, "artifacts"), db),
      outbox: createSqliteOutboxStore(db),
      unitOfWork: createSqliteStateUnitOfWork(db),
      github: createGithubRemote(rest),
      deployments: createGithubDeployReader(rest),
      approvals: {
        get: () => ({
          id: "approval-1",
          subjectId: "deploy-1",
          subjectHash: approvalSubjectHash(subject),
          subject,
          status: "approved" as const,
          version: 1,
          requestedAt: Date.now(),
          decision: {
            id: "approval-1",
            subject,
            decision: "approved" as const,
            actor: "po",
            source: "github-actor" as const,
            decidedAt: Date.now(),
          },
        }),
      },
      pipeline: {
        workflow: "deploy.yml",
        ref: "pipeline-1",
        workflowSha: "b".repeat(40),
        issueNumber: 48,
        allowedActors: ["po"],
        authorActor: "omi-bot",
      },
      hasher: { sha256: (text: string) => createHash("sha256").update(text).digest("hex") },
      now: Date.now,
      newId: randomUUID,
      newEventId: randomUUID,
      reconcileGraceMs: 1,
      retryBudget: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      jitter: () => 0,
      batchSize: 10,
      maxPolls: 1,
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
    };
  }
  const request = {
    repository: "acme/sandbox",
    environment: subject.environment,
    artifactDigest: subject.artifactDigest,
    approvalId: "approval-1",
  };
  try {
    let deps = wire();
    fake.inject({
      method: "POST",
      pathIncludes: "/dispatches",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    expect(await deployRelease(deps, request)).toMatchObject({ status: "pending" });
    // Simulate dying before the outbox records the transport outcome.
    db.prepare("UPDATE outbox SET state = 'in_flight'").run();
    deps.session.release();
    db.close();
    db = openStateDatabase(dbPath);
    deps = wire();
    expect(await deployRelease(deps, request)).toMatchObject({ status: "verified" });
    expect(
      fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
    ).toHaveLength(1);
    const audit = z
      .object({ payload: z.string() })
      .parse(db.prepare("SELECT payload FROM events WHERE kind = 'deploy.verified'").get());
    expect(audit.payload).toContain('"deploymentStatus":"success"');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
