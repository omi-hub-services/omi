import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeProject } from "../../../src/application/use-cases/project/initialize-project.ts";
import { flushOutbox } from "../../../src/application/use-cases/sync/flush-outbox.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createProjectConfigStore } from "../../../src/infrastructure/config/project-config-store.ts";
import { createGithubProjectReader } from "../../../src/infrastructure/github/github-project-reader.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { FakeGithubProjects } from "../../contract/github/fake-github-projects.ts";
import { baseline, fields, project } from "../../fixtures/github/project-mapping.ts";

let dir: string;
let db: StateDatabase;
let ids: number;
let now: number;
let fake: FakeGithubProjects;
const request = {
  config: baseline,
  source: {
    kind: "template",
    template: baseline.project,
    owner: "acme",
    title: "App",
    operationKey: "init-app",
  },
};
async function wire() {
  const client = createGithubRestClient({
    transport: fake,
    sleep: () => Promise.resolve(),
    now: () => now,
    random: () => 0,
  });
  const artifacts = createLocalArtifactStore(join(dir, "artifacts"), db);
  const outbox = createSqliteOutboxStore(db);
  const templateQueue = {
    artifacts,
    outbox,
    unitOfWork: createSqliteStateUnitOfWork(db),
    now: () => now,
    newId: () => `init-${String((ids += 1))}`,
  };
  const deps = {
    github: createGithubProjectReader(client),
    config: await createProjectConfigStore(join(dir, "config")),
    templateQueue,
  };
  const flush = () =>
    flushOutbox({
      artifacts,
      outbox,
      github: createGithubRemote(client),
      now: () => now,
      newEventId: templateQueue.newId,
      reconcileGraceMs: 60_000,
      retryBudget: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000 },
      jitter: () => 0,
      batchSize: 10,
    });
  return { deps, flush, outbox };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-project-init-"));
  mkdirSync(join(dir, "artifacts"));
  mkdirSync(join(dir, "config"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  ids = 0;
  now = Date.parse("2026-11-11T00:00:00.000Z");
  fake = new FakeGithubProjects([project]);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("template init with real SQLite, files and fake GitHub", () => {
  it("previews without intent, queues once on apply, then maps the copy's IDs and applies config", async () => {
    const h = await wire();
    expect((await initializeProject(h.deps, request)).status).toBe("preview");
    expect(db.prepare("SELECT * FROM outbox").all()).toEqual([]);
    await initializeProject(h.deps, { ...request, apply: true });
    await initializeProject(h.deps, { ...request, apply: true });
    expect(db.prepare("SELECT kind FROM events").all()).toEqual([
      { kind: "project.copy-requested" },
    ]);
    expect(h.outbox.get("init-app")).toMatchObject({ state: "pending", kind: "project.copy" });
    expect(await h.deps.config.read()).toBeUndefined();
    expect(fake.projects).toHaveLength(1);
    await h.flush();
    expect(h.outbox.get("init-app")).toMatchObject({
      state: "succeeded",
      remoteIdentity: "project:PVT_copy:9",
    });
    const mapping = {
      config: baseline,
      source: { kind: "existing", project: { owner: "acme", number: 9 }, fields },
    };
    await expect(initializeProject(h.deps, mapping)).rejects.toMatchObject({
      code: "FIELD_NOT_FOUND",
    });
    const copyFields = Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [
        key,
        {
          ...field,
          field_id: `copy_${field.field_id}`,
          options: Object.fromEntries(
            Object.entries(field.options).map(([key, value]) => [key, `copy_${value}`]),
          ),
        },
      ]),
    );
    const preview = await initializeProject(h.deps, {
      ...mapping,
      source: { ...mapping.source, fields: copyFields },
    });
    expect(preview).toMatchObject({
      status: "preview",
      proposed: { project: { mapping: { id: "PVT_copy", fields: copyFields } } },
    });
    expect(await h.deps.config.read()).toBeUndefined();
    const applied = await initializeProject(h.deps, {
      ...mapping,
      source: { ...mapping.source, fields: copyFields },
      apply: true,
    });
    expect(applied.status).toBe("applied");
    expect(await h.deps.config.read()).toMatchObject({
      project: { number: 9, mapping: { id: "PVT_copy", fields: copyFields } },
    });
  });

  it("reconciles timeout-after-copy across restart and never copies twice", async () => {
    const h = await wire();
    await initializeProject(h.deps, { ...request, apply: true });
    fake.copyThenTimeout = true;
    await h.flush();
    expect(h.outbox.get("init-app")?.state).toBe("outcome_unknown");
    db.close();
    db = openStateDatabase(join(dir, "state.db"));
    now += 120_000;
    const restarted = await wire();
    await restarted.flush();
    const resumed = await initializeProject(restarted.deps, { ...request, apply: true });
    expect(resumed).toMatchObject({
      queue: { state: "succeeded", remoteIdentity: "project:PVT_copy:9" },
    });
    expect(fake.projects).toHaveLength(2);
    expect(fake.requests.filter((r) => r.query.includes("copyProjectV2"))).toHaveLength(1);
  });

  it("refuses changed payloads for the same operation key and does not queue when config exists", async () => {
    const h = await wire();
    await initializeProject(h.deps, { ...request, apply: true });
    await expect(
      initializeProject(h.deps, {
        ...request,
        apply: true,
        source: { ...request.source, title: "Different" },
      }),
    ).rejects.toMatchObject({ code: "OPERATION_KEY_CONFLICT" });
    await h.deps.config.create(baseline);
    expect(
      (
        await initializeProject(h.deps, {
          ...request,
          apply: true,
          source: { ...request.source, operationKey: "other" },
        })
      ).status,
    ).toBe("config-exists");
    expect(db.prepare("SELECT operation_key FROM outbox").all()).toEqual([
      { operation_key: "init-app" },
    ]);
  });

  it("standalone intent requires an outbox entry and duplicate key adds no audit event", async () => {
    const h = await wire();
    const unit = h.deps.templateQueue.unitOfWork;
    const event = {
      eventId: "bad-event",
      kind: "project.copy-requested",
      subject: "x",
      correlationId: "x",
      payload: "{}",
    };
    expect(() =>
      unit.commit({ target: { kind: "outbox_intent" }, at: new Date(now).toISOString(), event }),
    ).toThrow("requires an outbox");
    await initializeProject(h.deps, { ...request, apply: true });
    const record = h.outbox.get("init-app");
    if (record === undefined) throw new Error("Missing queued intent");
    expect(
      unit.commit({
        target: { kind: "outbox_intent" },
        at: new Date(now).toISOString(),
        event,
        outbox: record,
      }),
    ).toEqual({ ok: false, reason: "ALREADY_EXISTS" });
    expect(db.prepare("SELECT kind FROM events").all()).toEqual([
      { kind: "project.copy-requested" },
    ]);
  });
});
