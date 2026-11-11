import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { preparePr } from "../../../src/application/use-cases/delivery/prepare-pr.ts";
import type { PreparePrDeps } from "../../../src/application/use-cases/delivery/prepare-pr.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createGithubPrDelivery } from "../../../src/infrastructure/github/github-pr-delivery.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createSqlitePrMappingStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-pr-mapping-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { FakeGithub } from "../../contract/github/fake-github.ts";
import { request } from "../../unit/application/use-cases/delivery/prepare-pr-fakes.ts";

it.each(["/pulls", "/comments"])(
  "persists intents, recovers %s timeout after restart and preserves mapping conflicts atomically",
  async (path) => {
    const dir = mkdtempSync(join(tmpdir(), "omi-prepare-pr-"));
    let db = openStateDatabase(join(dir, "state.db"));
    const now = () => Date.parse("2026-11-11T08:00:00.000Z");
    let id = 0;
    const newId = () => `delivery-${String(++id)}`;
    const fake = new FakeGithub({ now });
    fake.issues.push({
      number: 26,
      repo: "acme/app",
      title: "Task",
      body: "## Acceptance criteria\n- [ ] First\n- [ ] Second",
      createdAt: new Date(now()).toISOString(),
    });
    fake.inject({
      method: "POST",
      pathIncludes: path,
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    const client = createGithubRestClient({
      transport: fake,
      now,
      random: () => 0,
      sleep: () => Promise.resolve(),
    });
    function wire(): PreparePrDeps {
      return {
        now,
        newId,
        newEventId: newId,
        reconcileGraceMs: 120_000,
        batchSize: 10,
        jitter: () => 0,
        retryBudget: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 },
        artifacts: createLocalArtifactStore(join(dir, "artifacts"), db),
        unitOfWork: createSqliteStateUnitOfWork(db),
        outbox: createSqliteOutboxStore(db),
        mappings: createSqlitePrMappingStore(db),
        reader: createGithubPrDelivery(client),
        github: createGithubRemote(client),
      };
    }
    try {
      mkdirSync(join(dir, "artifacts"));
      applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
      db.prepare(
        "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        "project-1",
        "acme/app",
        "a".repeat(64),
        new Date(now()).toISOString(),
        new Date(now()).toISOString(),
      );
      expect(await preparePr(wire(), request)).toMatchObject({
        status: "pending",
        state: "outcome_unknown",
      });
      db.close();
      db = openStateDatabase(join(dir, "state.db"));
      const deps = wire();
      expect(await preparePr(deps, request)).toMatchObject({ status: "verified" });
      expect(await preparePr(deps, request)).toMatchObject({ status: "verified" });
      expect(fake.pulls).toHaveLength(1);
      expect(fake.comments).toHaveLength(1);
      expect(deps.outbox.listUnresolved()).toHaveLength(0);
      const saved = deps.mappings.get("project-1", "task-26");
      expect(saved).toMatchObject({ issueNumber: 26, prNumber: fake.pulls[0]?.number });
      if (saved === undefined) throw new Error("MISSING_MAPPING");
      expect(() => {
        deps.mappings.save({ ...saved, prNumber: 999 });
      }).toThrow("MAPPING_CONFLICT");
      expect(deps.mappings.get("project-1", "task-26")).toEqual(saved);
      // A PR conflict after inserting the Issue half rolls back that Issue half as well.
      expect(() => {
        deps.mappings.save({ ...saved, taskId: "task-other", issueNumber: 27 });
      }).toThrow();
      expect(deps.mappings.get("project-1", "task-other")).toBeUndefined();
      db.close();
      db = openStateDatabase(join(dir, "state.db"));
      expect(wire().mappings.get("project-1", "task-26")).toEqual(saved);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
