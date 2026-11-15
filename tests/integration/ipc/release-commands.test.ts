import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { expect, it } from "vitest";
import { commandSchema } from "../../../src/application/contracts/command.ts";
import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";
import {
  createReleaseDeliveryUseCases,
  createReleaseMergeUseCase,
  createRuntimeIpcServer,
} from "../../../src/bootstrap/container.ts";
import { operationMarker } from "../../../src/domain/delivery/operation-marker.ts";
import { releasePullKey } from "../../../src/domain/delivery/release-policy.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createProjectConfigStore } from "../../../src/infrastructure/config/project-config-store.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubReleaseReader } from "../../../src/infrastructure/github/github-release-reader.ts";
import { createGithubPrDelivery } from "../../../src/infrastructure/github/github-pr-delivery.ts";
import { createGithubReleaseMergeReader } from "../../../src/infrastructure/github/github-release-merge.ts";
import { createCommandDispatcher } from "../../../src/interfaces/ipc/command-dispatcher.ts";
import { sendCommand } from "../../../src/interfaces/ipc/ipc-client.ts";
import { FakeGithub } from "../../contract/github/fake-github.ts";

it.each(["dispatcher", "socket"])(
  "wires the configured release lifecycle through IPC %s",
  async (transport) => {
    expect(
      commandSchema.safeParse({ schemaVersion: 1, command: "release.prepare", release: "r1" })
        .success,
    ).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "omi-release-ipc-"));
    const squad = join(dir, ".omi");
    for (const path of ["config", "local/state", "local/artifacts"])
      mkdirSync(join(squad, path), { recursive: true });
    writeFileSync(
      join(squad, "config/project.yaml"),
      stringify({
        schema_version: 1,
        repository: { owner: "acme", name: "app" },
        project: { owner: "acme", number: 1 },
        branches: { integration: "develop", release: "main" },
        limits: { max_parallel_workers: 2, step_timeout_seconds: 60, max_rework_cycles: 2 },
        policies: { mandatory_approvals: ["release"], github_approval_actors: ["po"] },
        workspace: { worktree_root: join(dir, "worktrees") },
      }),
    );
    const db = openStateDatabase(join(squad, "local/state/state.sqlite"));
    const now = () => Date.parse("2026-11-14T00:00:00Z");
    const at = new Date(now()).toISOString();
    applyMigrations(db, loadMigrations(resolve("migrations")));
    db.prepare(
      "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
    ).run(at, at);
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(db),
      state: createSqliteStateUnitOfWork(db),
      owner: randomUUID(),
      now,
      nextId: randomUUID,
      leaseMs: 60_000,
    });
    const github = new FakeGithub({ now });
    const head = "a".repeat(40);
    github.pulls.push({
      repo: "acme/app",
      number: 5,
      title: "Task",
      body: "Issue: #30",
      createdAt: at,
      head: "task/omi-030-thing",
      base: "develop",
      merged: true,
      mergedAt: "2026-11-13T00:00:00Z",
    });
    const config = await (await createProjectConfigStore(join(squad, "config"))).read();
    if (config === undefined) throw new Error("MISSING_CONFIG");
    const repository = `${config.repository.owner}/${config.repository.name}`;
    const client = createGithubRestClient({
      transport: github,
      now,
      random: () => 0,
      sleep: () => Promise.resolve(),
    });
    const reader = createGithubReleaseMergeReader(client);
    const deps = {
      now,
      newId: randomUUID,
      newEventId: randomUUID,
      reconcileGraceMs: 120_000,
      batchSize: 10,
      jitter: () => 0,
      retryBudget: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 },
      artifacts: createLocalArtifactStore(join(squad, "local/artifacts"), db),
      unitOfWork: createSqliteStateUnitOfWork(db, session.lease),
      outbox: createSqliteOutboxStore(db),
      github: createGithubRemote(client),
      releases: createGithubReleaseReader(client),
    };
    const commands = {
      ...createReleaseDeliveryUseCases(
        { ...deps, pulls: createGithubPrDelivery(client) },
        { ...deps, pulls: reader },
        repository,
      ),
      mergeRelease: createReleaseMergeUseCase(
        { ...deps, reader },
        repository,
        config.policies.github_approval_actors ?? [],
      ),
    };
    const socketPath = join(dir, "runtime.sock");
    const identity = { runtimeVersion: "test", startedAt: at };
    const server = createRuntimeIpcServer({ socketPath, identity, runs: commands });
    const handler = createCommandDispatcher({
      ...commands,
      inspectRuntime: () => ({ ...identity, schemaVersion: 1, state: "ready" }),
    });
    const send = (input: Record<string, unknown>) => {
      const command = commandSchema.parse({ schemaVersion: 1, ...input });
      return transport === "socket" ? sendCommand({ socketPath, command }) : handler(command);
    };
    try {
      if (transport === "socket") await server.start();
      const prepare = { command: "release.prepare", release: "r1", title: "Release one" };
      expect(commandSchema.safeParse({ schemaVersion: 1, ...prepare }).success).toBe(true);
      // A lost create response must be recovered through the durable outbox on retry.
      github.inject({
        method: "POST",
        pathIncludes: "/issues",
        effect: { type: "apply_then_fail", failure: "timeout" },
      });
      expect(await send(prepare)).toMatchObject({ ok: true, result: { status: "pending" } });
      const prepared = await send(prepare);
      expect(prepared).toMatchObject({ ok: true, result: { status: "verified", headSha: head } });
      expect(await send(prepare)).toEqual(prepared);
      const pull = github.pulls.find((p) => p.head === "develop");
      if (pull === undefined) throw new Error("MISSING_RELEASE_PULL");
      expect(prepared).toMatchObject({ result: { prNumber: pull.number } });
      expect(pull).toMatchObject({ repo: "acme/app", base: "main", title: "Release one" });
      expect(pull.body).toContain(operationMarker(releasePullKey("acme/app", "r1")));
      const publish = { command: "release.publish", release: "r1", prNumber: pull.number };
      expect(await send(publish)).toMatchObject({
        ok: false,
        error: { code: "COMMAND_REFUSED", message: "RELEASE_PR_NOT_MERGED" },
      });
      const merge = {
        command: "release.merge",
        release: "r1",
        prNumber: pull.number,
        expectedHeadSha: head,
        requiredChecks: ["ci"],
      };
      github.statuses.push({ repo: "acme/app", sha: head, context: "ci", state: "success" });
      const refusedMerge = await send(merge);
      expect(refusedMerge).toMatchObject({
        ok: false,
        error: { code: "COMMAND_REFUSED" },
      });
      expect(JSON.stringify(refusedMerge)).toContain("PO_APPROVAL_MISSING");
      expect(pull.merged).not.toBe(true);
      github.reviews.push({
        repo: "acme/app",
        pullNumber: pull.number,
        login: "po",
        type: "User",
        state: "APPROVED",
        commitId: head,
      });
      expect(await send(merge)).toMatchObject({ ok: true, result: { status: "done" } });
      github.tags.set("acme/app:conflict", "d".repeat(40));
      expect(await send({ ...publish, release: "conflict" })).toMatchObject({
        ok: false,
        error: { code: "COMMAND_REFUSED", message: "TAG_POINTS_ELSEWHERE" },
      });
      const published = await send({ ...publish, title: "Published release" });
      expect(published).toMatchObject({
        ok: true,
        result: { status: "published", tag: "r1", commitSha: pull.mergeCommitSha },
      });
      expect(await send({ ...publish, title: "Published release" })).toEqual(published);
      expect(github.issues).toHaveLength(1);
      expect(github.pulls).toHaveLength(2);
      expect(github.releases).toHaveLength(1);
      expect(await send({ command: "release.prepare", release: "empty" })).toMatchObject({
        ok: false,
        error: { code: "COMMAND_REFUSED", message: "RELEASE_EMPTY" },
      });
    } finally {
      await server.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
