import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { commandSchema } from "../../../src/application/contracts/command.ts";
import type { DeployConfig } from "../../../src/application/contracts/project-config.ts";
import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";
import { createDeployUseCase, createRuntimeIpcServer } from "../../../src/bootstrap/container.ts";
import { approvalSubjectHash } from "../../../src/domain/approvals/approval.ts";
import type { ApprovalRequest } from "../../../src/domain/approvals/approval.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createGithubDeployReader } from "../../../src/infrastructure/github/github-deploy.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createCommandDispatcher } from "../../../src/interfaces/ipc/command-dispatcher.ts";
import { sendCommand } from "../../../src/interfaces/ipc/ipc-client.ts";
import { FakeGithub } from "../../contract/github/fake-github.ts";

const digest = `sha256:${"a".repeat(64)}`;
const deploy: DeployConfig = {
  workflow: "deploy.yml",
  tag_ref: "deploy-r1",
  workflow_sha: "b".repeat(40),
  issue_number: 48,
  allowed_actors: ["po"],
  author_actor: "omi-bot",
  allowed_repositories: ["acme/app"],
  allowed_environments: ["staging"],
};

it.each(["dispatcher", "socket"])(
  "deploys a configured target through IPC %s and reconciles a repeat",
  async (transport) => {
    const dir = mkdtempSync(join(tmpdir(), "omi-deploy-ipc-"));
    mkdirSync(join(dir, "artifacts"));
    const db = openStateDatabase(join(dir, "state.sqlite"));
    applyMigrations(db, loadMigrations(resolve("migrations")));
    const now = () => Date.parse("2026-11-14T00:00:00Z");
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(db),
      state: createSqliteStateUnitOfWork(db),
      owner: randomUUID(),
      now,
      nextId: randomUUID,
      leaseMs: 60_000,
    });
    const github = new FakeGithub({ now });
    github.tags.set("acme/app:deploy-r1", "b".repeat(40));
    github.deployEnvironment = "staging";
    const client = createGithubRestClient({
      transport: github,
      now,
      random: () => 0,
      sleep: () => Promise.resolve(),
    });
    const subject = { kind: "deploy" as const, artifactDigest: digest, environment: "staging" };
    const approvals: ApprovalRequest[] = [];
    const deployCommand = createDeployUseCase({
      now,
      newId: randomUUID,
      newEventId: randomUUID,
      reconcileGraceMs: 120_000,
      batchSize: 10,
      jitter: () => 0,
      retryBudget: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 },
      artifacts: createLocalArtifactStore(join(dir, "artifacts"), db),
      unitOfWork: createSqliteStateUnitOfWork(db, session.lease),
      outbox: createSqliteOutboxStore(db),
      github: createGithubRemote(client),
      session,
      hasher: { sha256: (text) => createHash("sha256").update(text).digest("hex") },
      approvals: { get: (id) => approvals.find((a) => a.id === id), list: () => approvals },
      deployments: createGithubDeployReader(client),
      deploy,
      targets: [{ id: "app-r1", target_environment: "staging", artifact_digest: digest }],
      repository: "acme/app",
      sleep: () => Promise.resolve(),
      maxPolls: 2,
      pollIntervalMs: 0,
    });
    const commands = { deploy: deployCommand };
    const socketPath = join(dir, "runtime.sock");
    const identity = { runtimeVersion: "test", startedAt: new Date(now()).toISOString() };
    const server = createRuntimeIpcServer({ socketPath, identity, runs: commands });
    const handler = createCommandDispatcher({
      ...commands,
      inspectRuntime: () => ({ ...identity, schemaVersion: 1, state: "ready" }),
    });
    const send = (input: Record<string, unknown>) => {
      const command = commandSchema.parse({ schemaVersion: 1, ...input });
      return transport === "socket" ? sendCommand({ socketPath, command }) : handler(command);
    };
    const dispatches = () =>
      github.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")).length;
    try {
      if (transport === "socket") await server.start();
      const deployTarget = { command: "deploy", target: "app-r1" };
      expect(await send(deployTarget)).toMatchObject({
        ok: false,
        error: { code: "COMMAND_REFUSED", message: "NO_APPROVAL" },
      });
      expect(dispatches()).toBe(0);
      approvals.push({
        id: "approval-1",
        subjectId: "app-r1",
        subjectHash: approvalSubjectHash(subject),
        subject,
        status: "approved",
        version: 1,
        requestedAt: now(),
        decision: {
          id: "approval-1",
          subject,
          decision: "approved",
          actor: "po",
          source: "github-actor",
          decidedAt: now(),
        },
      });
      github.inject({
        method: "POST",
        pathIncludes: "/dispatches",
        effect: { type: "apply_then_fail", failure: "timeout" },
      });
      expect(await send(deployTarget)).toMatchObject({ ok: true, result: { status: "pending" } });
      expect(await send(deployTarget)).toMatchObject({ ok: true, result: { status: "verified" } });
      expect(await send(deployTarget)).toMatchObject({ ok: true, result: { status: "verified" } });
      expect(dispatches()).toBe(1);
      expect(await send({ command: "deploy", target: "missing" })).toMatchObject({
        ok: false,
        error: { code: "COMMAND_REFUSED", message: "DEPLOY_TARGET_NOT_FOUND" },
      });
    } finally {
      await server.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
