import { inspectRuntime } from "../../../src/application/use-cases/project/inspect-runtime.ts";
import { presentStatus } from "../../../src/interfaces/cli/presenters/status-presenter.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProfileMetadata } from "../../../src/application/contracts/profile-metadata.ts";
import { selectExecutor } from "../../../src/application/use-cases/profiles/select-executor.ts";
import { probeProfile } from "../../../src/application/use-cases/profiles/probe-profile.ts";
import type { ExecutionResult } from "../../../src/application/contracts/agent-execution.ts";
import { createSqliteProfileRegistry } from "../../../src/infrastructure/profiles/sqlite-profile-registry.ts";
import { createSqliteExecutorSelectionStore } from "../../../src/infrastructure/profiles/sqlite-executor-selection-store.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  observedProfile,
  type ProfileMetadata,
} from "../../../src/domain/profiles/profile-metadata.ts";

let dir: string;
let db: StateDatabase;
const now = 1000;
const profile = (id: string, overrides: Partial<ProfileMetadata> = {}): ProfileMetadata => ({
  profileId: id,
  tool: "claude-code",
  authMode: "subscription",
  credentialRef: `/profiles/${id}`,
  accountGroupId: id,
  modelAllowlist: ["tested-model"],
  state: "ready",
  lastProbeAt: now,
  probeTtlMs: 100,
  maxConcurrency: 1,
  accountGroupMaxConcurrency: 1,
  preference: 1,
  ...overrides,
});
const models = {
  schema_version: 1,
  models: {
    claude: {
      executor: "claude-code",
      model: "tested-model",
      supported_efforts: ["medium", "high"],
    },
    codex: { executor: "codex", model: "tested-codex", supported_efforts: ["high", "xhigh"] },
  },
  capability_profiles: { coding: { min_effort: "high" } },
  verified_models: { coding: ["claude", "codex"] },
};
const request = (attemptId = "a", extra: Record<string, unknown> = {}) => ({
  attemptId,
  stepRunId: "s",
  attemptNumber: 1,
  capabilityProfile: "coding",
  now,
  models,
  ...extra,
});
function result(
  attemptId: string,
  executor: "claude-code" | "codex" = "claude-code",
): ExecutionResult {
  return {
    attemptId,
    executionId: `exec-${attemptId}`,
    executor,
    outcome: "succeeded",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    model: { requested: executor === "codex" ? "tested-codex" : "tested-model" },
    effort: { requested: "high" },
    authMode: "subscription",
    toolsUsed: [],
    eventCount: 0,
    unparsedLines: 0,
    escalated: false,
    leftoverProcessesKilled: false,
  };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-profiles-"));
  db = openStateDatabase(join(dir, "state.sqlite"));
  applyMigrations(db, loadMigrations(resolve("migrations")));
  db.exec(`INSERT INTO projects VALUES ('p','repo',NULL,'h','t','t');
    INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('t','p','i',1,'h','t','{}','t');
    INSERT INTO workflow_runs (id,task_id,template_hash,status,quality_phase,created_at,updated_at) VALUES ('r','t','h','running','implementation','t','t');
    INSERT INTO step_runs (id,run_id,step_key,status,created_at,updated_at) VALUES ('s','r','k','ready','t','t');`);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite registry and executor selection", () => {
  it("persists metadata across restart, presents TTL expiry and preserves login-required", () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(profile("a"), now);
    registry.save(profile("login", { state: "login-required" }), now);
    db.close();
    db = openStateDatabase(join(dir, "state.sqlite"));
    const restored = createSqliteProfileRegistry(db).list();
    expect(restored.map((entry) => observedProfile(entry, now + 100).state)).toEqual([
      "unknown",
      "login-required",
    ]);
    expect(restored[0]?.metadata).toEqual(profile("a"));
    expect(applyMigrations(db, loadMigrations(resolve("migrations"))).applied).toEqual([]);
  });

  it("refuses tokens, credential-file refs, API auth, extra fields and a second Codex profile", () => {
    const registry = createSqliteProfileRegistry(db);
    for (const metadata of [
      { ...profile("a"), token: "fake" },
      { ...profile("a"), credentialRef: "/profiles/auth.json" },
      { ...profile("a"), authMode: "api-key" },
      { ...profile("a"), modelAllowlist: ["ghp_fakeSecret123"] },
      { ...profile("a"), preference: -1 },
      { ...profile("a"), maxConcurrency: 0 },
    ])
      expect(() => parseProfileMetadata(metadata)).toThrow();
    expect(registry.list()).toEqual([]);
    registry.save(profile("cx", { tool: "codex" }), now);
    expect(() => registry.save(profile("cx2", { tool: "codex" }), now)).toThrow(/one Codex/);
    expect(registry.list()).toHaveLength(1);
  });

  it("atomically reserves capacity across connections and across profiles of one account", () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(profile("a", { accountGroupId: "shared" }), now);
    registry.save(profile("b", { accountGroupId: "shared" }), now);
    const first = selectExecutor(
      createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db)),
      request(),
    );
    expect(first).toMatchObject({
      outcome: "selected",
      effort: "high",
      candidate: { profileId: "a" },
    });
    const other = openStateDatabase(join(dir, "state.sqlite"));
    try {
      const second = selectExecutor(
        createSqliteExecutorSelectionStore(other, createSqliteProfileRegistry(other)),
        request("b", { attemptNumber: 2 }),
      );
      expect(second.outcome).toBe("waiting_resource");
      if (second.outcome !== "waiting_resource") throw new Error("Expected resource wait");
      expect(second.rejections.find((entry) => entry.candidateId === "b:claude")).toEqual({
        candidateId: "b:claude",
        reasons: ["ACCOUNT_GROUP_AT_CONCURRENCY_LIMIT"],
      });
      expect(other.prepare("SELECT count(*) AS n FROM agent_attempts").get()).toEqual({ n: 1 });
    } finally {
      other.close();
    }
  });

  it("propagates a persisted cooldown to another directory of the same account", () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(
      profile("limited", { accountGroupId: "shared", state: "cooldown", cooldownUntil: now + 50 }),
      now,
    );
    registry.save(profile("sibling", { accountGroupId: "shared", preference: 0 }), now);
    registry.save(profile("independent", { preference: 9 }), now);
    expect(
      selectExecutor(
        createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db)),
        request(),
      ),
    ).toMatchObject({
      outcome: "selected",
      candidate: { profileId: "independent" },
      effort: "high",
    });
  });

  it("does not count multiple model aliases as multiple workers", () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(profile("a", { maxConcurrency: 2, accountGroupMaxConcurrency: 2 }), now);
    const store = createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db));
    const config = {
      ...models,
      models: { ...models.models, extra: models.models.claude },
      verified_models: { coding: ["claude", "codex", "extra"] },
    };
    expect(selectExecutor(store, request("a", { models: config })).outcome).toBe("selected");
    expect(selectExecutor(store, request("b", { models: config, attemptNumber: 2 })).outcome).toBe(
      "selected",
    );
    expect(selectExecutor(store, request("c", { models: config, attemptNumber: 3 })).outcome).toBe(
      "waiting_resource",
    );
  });

  it("waits for required Codex; otherwise fails over with the same effort floor and attempt history", () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(
      profile("cx", { tool: "codex", preference: 0, modelAllowlist: ["tested-codex"] }),
      now,
    );
    registry.save(profile("cc"), now);
    const store = createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db));
    expect(selectExecutor(store, request())).toMatchObject({
      candidate: { executor: "codex" },
      effort: "high",
    });
    store.recordResult("a", result("a", "codex"));
    db.prepare("UPDATE agent_attempts SET status='failed' WHERE id='a'").run();
    registry.save(
      profile("cx", {
        tool: "codex",
        preference: 0,
        modelAllowlist: ["tested-codex"],
        state: "cooldown",
        cooldownUntil: now + 50,
      }),
      now,
    );
    expect(
      selectExecutor(store, request("required", { attemptNumber: 2, requiredExecutor: "codex" })),
    ).toMatchObject({ outcome: "waiting_resource", reason: "NO_MATCHING_COMBINATION" });
    expect(selectExecutor(store, request("failover", { attemptNumber: 2 }))).toMatchObject({
      candidate: { executor: "claude-code" },
      effort: "high",
    });
    const completed = result("failover");
    completed.model.actual = "reported-model-revision";
    completed.effort.actual = "high";
    store.recordResult("failover", completed);
    db.close();
    db = openStateDatabase(join(dir, "state.sqlite"));
    const persisted = createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db));
    expect(persisted.settings("a")).toEqual({
      selectionReason:
        "missing Project fields: Workflow, Work Type, Area, Priority; default medium; complexity medium requires medium; capability floor high; minimum high",
      chosen: { executor: "codex", profileId: "cx", model: "tested-codex", effort: "high" },
    });
    expect(persisted.settings("failover")).toMatchObject({
      chosen: { effort: "high", profileId: "cc" },
      actualModel: "reported-model-revision",
      actualEffort: "high",
    });
    expect(() => {
      persisted.recordResult("failover", {
        ...completed,
        model: { requested: "tested-model", actual: "conflict" },
      });
    }).toThrow(/already recorded/);
    expect(() => {
      persisted.recordResult("a", result("other", "codex"));
    }).toThrow(/disagrees/);
  });

  it("explains empty configuration and rejects models outside the verified profile allowlist", () => {
    const store = createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db));
    expect(selectExecutor(store, request())).toMatchObject({
      outcome: "waiting_resource",
      reason: "NO_MATCHING_COMBINATION",
    });
    createSqliteProfileRegistry(db).save(profile("a", { modelAllowlist: [] }), now);
    expect(selectExecutor(store, request())).toMatchObject({
      outcome: "waiting_resource",
      rejections: [{ reasons: ["MODEL_NOT_ALLOWLISTED"] }],
    });
    expect(db.prepare("SELECT count(*) AS n FROM agent_attempts").get()).toEqual({ n: 0 });
  });

  it("enforces the tool requirement declared by the capability profile without request overrides", () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(profile("cc"), now);
    const store = createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db));
    const config = {
      ...models,
      capability_profiles: { coding: { min_effort: "high", required_executor: "codex" } },
    };
    expect(selectExecutor(store, request("a", { models: config })).outcome).toBe(
      "waiting_resource",
    );
    expect(() =>
      selectExecutor(store, request("a", { models: config, requiredExecutor: "claude-code" })),
    ).toThrow(/conflicts/);
    expect(db.prepare("SELECT count(*) AS n FROM agent_attempts").get()).toEqual({ n: 0 });
  });

  it("rolls back a failed reservation without losing metadata or consuming a slot", () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(profile("a"), now);
    const store = createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db));
    expect(() => selectExecutor(store, request("bad", { stepRunId: "missing" }))).toThrow(
      /FOREIGN KEY/,
    );
    expect(registry.list()[0]?.activeWorkers).toBe(0);
    expect(selectExecutor(store, request()).outcome).toBe("selected");
    expect(() => selectExecutor(store, request())).toThrow(/already exists/);
  });

  it("fakes the existing probe port, preserves allowlist, and refuses stale results", async () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(profile("a", { state: "unknown" }), now);
    const probe = {
      executor: "claude-code" as const,
      probe(input: { profileHome: string }) {
        expect(input.profileHome).toBe("/profiles/a");
        return Promise.resolve({
          executor: "claude-code" as const,
          status: "ready" as const,
          compatibility: "supported" as const,
          supportedRange: "test",
        });
      },
    };
    expect(await probeProfile(registry, probe, "a", () => now)).toMatchObject({
      outcome: "probed",
    });
    expect(registry.list()[0]?.metadata.modelAllowlist).toEqual(["tested-model"]);
    const race = {
      ...probe,
      async probe(input: { profileHome: string }) {
        registry.save(profile("a", { state: "disabled" }), now);
        return probe.probe(input);
      },
    };
    expect(await probeProfile(registry, race, "a", () => now)).toMatchObject({ outcome: "stale" });
    expect(registry.list()[0]?.metadata.state).toBe("disabled");
  });
  it("persists task choice and reason across reopen and exposes it through status", () => {
    const registry = createSqliteProfileRegistry(db);
    registry.save(profile("cc"), now);
    const selected = selectExecutor(
      createSqliteExecutorSelectionStore(db, registry),
      request("complex", {
        task: { workflow: "poc", workType: "Spike", area: "runtime", priority: "P1", acCount: 6 },
      }),
    );
    expect(selected).toMatchObject({ outcome: "selected", effort: "high" });
    db.close();
    db = openStateDatabase(join(dir, "state.sqlite"));
    const store = createSqliteExecutorSelectionStore(db, createSqliteProfileRegistry(db));
    const status = inspectRuntime(
      { runtimeVersion: "test", startedAt: "2026-11-11T00:00:00.000Z" },
      store,
    );
    expect(status.attempts).toEqual([
      {
        attemptId: "complex",
        settings: {
          chosen: {
            executor: "claude-code",
            profileId: "cc",
            model: "tested-model",
            effort: "high",
          },
          selectionReason:
            "research / Spike / PoC; complexity high requires high; capability floor high; minimum high",
        },
      },
    ]);
    const presented = presentStatus({ ok: true, result: status }, "text");
    expect(JSON.stringify(presented)).toContain(
      "model: tested-model effort: high reason: research / Spike / PoC",
    );
    expect(JSON.stringify(presentStatus({ ok: true, result: status }, "json"))).toContain(
      "selectionReason",
    );
  });
});
