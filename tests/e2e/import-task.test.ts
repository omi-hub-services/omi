import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import {
  createRuntimeIpcServer,
  createTaskImportUseCase,
  createApprovalUseCases,
} from "../../src/bootstrap/container.ts";
import { createGithubRestClient } from "../../src/infrastructure/github/github-rest-client.ts";
import { createSqliteTaskApprovalSubjects } from "../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import { projectConfigSchema } from "../../src/application/contracts/project-config.ts";
import { createCommandDispatcher } from "../../src/interfaces/ipc/command-dispatcher.ts";
import { inspectRuntime } from "../../src/application/use-cases/project/inspect-runtime.ts";
import { openStateDatabase } from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteLeaseStore } from "../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { claimProjectSession } from "../../src/application/services/claim-project-session.ts";
import { runCli } from "../../src/interfaces/cli/commands/create-program.ts";
import { sendCommand } from "../../src/interfaces/ipc/ipc-client.ts";
import { baseline } from "../fixtures/github/project-mapping.ts";
import { issue } from "../fixtures/github/task-import.ts";
import { syncGithub } from "../../src/application/use-cases/sync/sync-github.ts";
import { createSqliteOutboxStore } from "../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createLocalArtifactStore } from "../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createGithubRemote } from "../../src/infrastructure/github/github-remote.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(socket = false, sync = false) {
  const directory = mkdtempSync(join(tmpdir(), "omi-import-"));
  const squad = join(directory, ".omi-squad");
  for (const name of ["config", "roles", "rules", "workflows", "provenance", "local/runs"])
    mkdirSync(join(squad, name), { recursive: true });
  writeFileSync(
    join(squad, "config/project.yaml"),
    stringify({
      ...baseline,
      project: {
        ...baseline.project,
        mapping: { id: "PVT_1", owner_type: "Organization", fields: {} },
      },
    }),
  );
  writeFileSync(
    join(squad, "config/models.yaml"),
    "schema_version: 1\nmodels: {}\ncapability_profiles: {}\nverified_models: {}\n",
  );
  writeFileSync(join(squad, "provenance/skills.lock.json"), '{"skills":[]}');
  const db = openStateDatabase(join(directory, "state.sqlite"));
  applyMigrations(db, loadMigrations(resolve("migrations")));
  const session = claimProjectSession({
    leases: createSqliteLeaseStore(db),
    state: createSqliteStateUnitOfWork(db),
    owner: randomUUID(),
    nextId: randomUUID,
    now: Date.now,
    leaseMs: 60_000,
  });
  const issues = [structuredClone(issue), { ...structuredClone(issue), id: "I_2", number: 2 }];
  const calls: string[] = [];
  let archived = false;
  const remote = {
    status: 200,
    writeStatus: 201,
    importStatus: 200,
    comments: [] as { id: number; body: string }[],
    onLookup: () => {},
  };
  const requests: { method: string; path: string }[] = [];
  const transport = {
    send(request: import("../../src/infrastructure/github/github-transport.ts").HttpRequest) {
      calls.push(request.path);
      requests.push({ method: request.method, path: request.path });
      if (request.path.includes("/comments")) {
        if (request.method === "GET") {
          remote.onLookup();
          return Promise.resolve({
            status: remote.status,
            headers: { "retry-after": "120" },
            body: JSON.stringify(remote.comments),
          });
        }
        return Promise.resolve({
          status: remote.writeStatus,
          headers: { "retry-after": "120" },
          body: JSON.stringify({ id: 99 }),
        });
      }
      let data: unknown;
      if (remote.importStatus !== 200)
        return Promise.resolve({
          status: remote.importStatus,
          headers: { "retry-after": "120" },
          body: "{}",
        });
      if (request.method === "GET") {
        const number = Number(request.path.split("/").at(-1));
        data = { number, node_id: `I_${String(number)}` };
        return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(data) });
      }
      const { query, variables } = z
        .object({ query: z.string(), variables: z.object({ id: z.string() }) })
        .parse(request.body);
      const page = (nodes: unknown[]) => ({
        totalCount: nodes.length,
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      });
      if (query.includes("TaskItems"))
        data = {
          node: {
            id: variables.id,
            __typename: "ProjectV2",
            items: page(
              issues.map((i) => ({
                id: `PVTI_${String(i.number)}`,
                isArchived: archived,
                content: { __typename: "Issue", id: i.id },
              })),
            ),
          },
        };
      else if (query.includes("TaskIterations"))
        data = { node: { id: variables.id, __typename: "ProjectV2Item", fieldValues: page([]) } };
      else {
        const found = issues.find((i) => i.id === variables.id);
        data = {
          node:
            found === undefined
              ? null
              : {
                  ...found,
                  __typename: "Issue",
                  repository: {
                    owner: { login: found.repository.owner },
                    name: found.repository.name,
                  },
                  milestone: null,
                  blockedBy: page(found.blockedBy.map((id) => ({ id }))),
                },
        };
      }
      return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify({ data }) });
    },
  };
  const config = projectConfigSchema.parse({
    ...baseline,
    project: {
      ...baseline.project,
      mapping: { id: "PVT_1", owner_type: "Organization", fields: {} },
    },
  });
  const client = createGithubRestClient({
    transport,
    now: Date.now,
    random: () => 0,
    sleep: () => Promise.resolve(),
  });
  const tasks = {
    importTasks: createTaskImportUseCase({ database: db, session, config, client, now: Date.now }),
    ...(sync
      ? {
          sync: (input: unknown) =>
            syncGithub(
              {
                session,
                importTasks: createTaskImportUseCase({
                  database: db,
                  session,
                  config,
                  client,
                  now: Date.now,
                }),
                outbox: createSqliteOutboxStore(db),
                artifacts: createLocalArtifactStore(join(squad, "local/runs"), db),
                github: createGithubRemote(client),
                now: Date.now,
                newEventId: randomUUID,
                reconcileGraceMs: 120_000,
                retryBudget: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 },
                jitter: () => 0,
                batchSize: 10,
              },
              input,
            ),
        }
      : {}),
  };
  const approvals = createApprovalUseCases({
    database: db,
    subjects: createSqliteTaskApprovalSubjects(db),
    repository: "acme/app",
    allowedGitHubActors: [],
    fence: session.lease,
  });
  const identity = { runtimeVersion: "test", startedAt: new Date().toISOString() };
  const dispatch = createCommandDispatcher({
    inspectRuntime: () => inspectRuntime(identity),
    ...tasks,
    ...approvals,
  });
  const socketPath = join(directory, "ipc/runtime.sock");
  const server = createRuntimeIpcServer({ socketPath, identity, tasks, approvals });
  cleanup.push(async () => {
    await server.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  if (socket) await server.start();
  const cli = async (...args: string[]) => {
    let out = "",
      err = "";
    const code = await runCli(args, {
      defaultSocketPath: socketPath,
      sendCommand: socket ? sendCommand : async (request) => dispatch(request.command),
      timeoutMs: 5000,
      version: "test",
      stdout: (t) => {
        out += t;
      },
      stderr: (t) => {
        err += t;
      },
    });
    return { code, out, err };
  };
  return {
    cli,
    db,
    issues,
    calls,
    session,
    directory,
    remote,
    requests,
    enqueue(key: string, state = "pending", updatedAt = "2026-11-01T00:00:00.000Z") {
      const root = join(squad, "local/runs");
      mkdirSync(root, { recursive: true });
      const payload = JSON.stringify({
        schemaVersion: 1,
        operation: { type: "issue.comment", repo: "acme/app", issueNumber: 1, body: "queued" },
      });
      const ref = createLocalArtifactStore(root, db).write({
        id: key,
        path: `${key}.json`,
        bytes: new TextEncoder().encode(payload),
        classification: "outbox-payload",
        createdAt: new Date().toISOString(),
      });
      db.prepare(
        "INSERT INTO outbox (operation_key, kind, subject, payload_ref, payload_hash, state, attempt_count, created_at, updated_at) VALUES (?, 'issue.comment', 'task-1', ?, ?, ?, 1, ?, ?)",
      ).run(key, `${key}.json`, ref.sha256, state, updatedAt, updatedAt);
    },
    archive: () => {
      archived = true;
    },
  };
}

it("sync reads unknown remote outcomes before flushing queued writes and importing selected Issues, idempotently", async () => {
  const s = await setup(false, true);
  s.enqueue("unknown", "outcome_unknown");
  s.enqueue("pending");
  s.remote.comments = [{ id: 42, body: "<!-- omi-squad:operation:unknown -->" }];
  const first = await s.cli("sync", "--issues", "1", "2", "--json");
  expect(first.code, first.out + first.err).toBe(0);
  expect(JSON.parse(first.out)).toMatchObject({
    result: {
      schemaVersion: 1,
      githubUnavailable: false,
      reconcile: { entries: [{ operationKey: "unknown", outcome: "succeeded" }] },
      attempts: [{ operationKey: "pending", outcome: "succeeded" }],
      snapshots: [{ taskId: "task-1" }, { taskId: "task-2" }],
    },
  });
  expect(s.requests[0]?.method).toBe("GET");
  expect(s.requests[1]?.method).toBe("POST");
  const before = s.db.prepare("SELECT * FROM task_snapshots ORDER BY id").all();
  const second = await s.cli("sync", "--issues", "1", "2", "--json");
  expect(second.code, second.out).toBe(0);
  expect(JSON.parse(second.out)).toMatchObject({
    result: {
      reconcile: { entries: [] },
      attempts: [],
      snapshots: [{ outcome: "unchanged" }, { outcome: "unchanged" }],
    },
  });
  expect(s.db.prepare("SELECT * FROM task_snapshots ORDER BY id").all()).toEqual(before);
  expect(s.requests.filter((r) => r.method === "POST" && r.path.includes("comments"))).toHaveLength(
    1,
  );
  expect(s.db.prepare("SELECT count(*) AS n FROM approvals").get()).toEqual({ n: 0 });
});

it.each([
  [401, "GITHUB_UNAVAILABLE"],
  [429, "RATE_LIMITED"],
])(
  "sync reports unavailable and deferred operations for HTTP %s without writes or imports",
  async (status, code) => {
    const s = await setup(false, true);
    s.enqueue("unknown", "outcome_unknown");
    s.enqueue("later", "outcome_unknown");
    s.enqueue("pending");
    s.remote.status = status;
    const result = await s.cli("sync", "--issues", "1", "--json");
    expect(result.code, result.out).toBe(4);
    expect(JSON.parse(result.out)).toMatchObject({
      error: { code },
      result: {
        githubUnavailable: true,
        reconcile: { entries: [{ outcome: "unavailable" }, { outcome: "deferred" }] },
        attempts: [],
        snapshots: [],
      },
    });
    expect(s.requests).toHaveLength(1);
    expect(s.db.prepare("SELECT state FROM outbox ORDER BY id").all()).toEqual([
      { state: "outcome_unknown" },
      { state: "outcome_unknown" },
      { state: "pending" },
    ]);
  },
);

it("sync reports stale reconciliation without overwriting a concurrently settled row", async () => {
  const s = await setup(false, true);
  s.enqueue("unknown", "outcome_unknown");
  s.remote.onLookup = () => {
    s.db
      .prepare(
        "UPDATE outbox SET state='succeeded', remote_identity='other' WHERE operation_key='unknown'",
      )
      .run();
  };
  const result = await s.cli("sync", "--json");
  expect(result.code, result.out).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({
    result: { reconcile: { entries: [{ outcome: "stale" }] }, attempts: [] },
  });
  expect(s.db.prepare("SELECT remote_identity FROM outbox").get()).toEqual({
    remote_identity: "other",
  });
});

it("sync preserves waiting operations inside the reconciliation grace period", async () => {
  const s = await setup(false, true);
  s.enqueue("unknown", "outcome_unknown", new Date().toISOString());
  const result = await s.cli("sync", "--json");
  expect(result.code, result.out).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({
    result: { reconcile: { entries: [{ outcome: "waiting" }] }, attempts: [] },
  });
  expect(s.requests).toHaveLength(1);
});

it("sync refuses a lost project lease before remote I/O", async () => {
  const s = await setup(false, true);
  s.enqueue("pending");
  s.session.release();
  const result = await s.cli("sync", "--json");
  expect(result.code).toBe(4);
  expect(result.out).toContain("PROJECT_LOCK_LOST");
  expect(s.requests).toEqual([]);
});

it("sync applies the outbox rate limit and keeps unattempted queued writes pending", async () => {
  const s = await setup(false, true);
  s.enqueue("pending");
  s.enqueue("later");
  s.remote.writeStatus = 429;
  const result = await s.cli("sync", "--json");
  expect(result.code, result.out).toBe(4);
  expect(JSON.parse(result.out)).toMatchObject({
    error: { code: "RATE_LIMITED" },
    result: { attempts: [{ operationKey: "pending", outcome: "rejected_retry" }] },
  });
  expect(s.requests).toHaveLength(1);
  expect((await s.cli("sync", "--json")).code).toBe(4);
});

it.each([
  [401, "GITHUB_UNAVAILABLE"],
  [429, "RATE_LIMITED"],
])("sync classifies an unavailable requested Issue import for HTTP %s", async (status, code) => {
  const s = await setup(false, true);
  s.remote.importStatus = status;
  const result = await s.cli("sync", "--issues", "1", "--json");
  expect(result.code).toBe(4);
  expect(JSON.parse(result.out)).toMatchObject({
    error: { code },
    result: { githubUnavailable: true, snapshots: [] },
  });
});

it("sync stops sending if the lease is lost during marker lookup", async () => {
  const s = await setup(false, true);
  s.enqueue("unknown", "outcome_unknown");
  s.enqueue("pending");
  s.remote.onLookup = () => {
    s.session.release();
  };
  const result = await s.cli("sync", "--issues", "1", "--json");
  expect(result.code).toBe(4);
  expect(result.out).toContain("PROJECT_LOCK_LOST");
  expect(s.requests).toHaveLength(1);
  expect(s.db.prepare("SELECT state FROM outbox ORDER BY id").all()).toEqual([
    { state: "outcome_unknown" },
    { state: "pending" },
  ]);
});

it("sync refreshes the business baseline without changing an existing approval", async () => {
  const s = await setup(false, true);
  expect((await s.cli("sync", "--issues", "1")).code).toBe(0);
  expect((await s.cli("approvals", "request", "task-1", "--kind", "business")).code).toBe(0);
  const before = s.db.prepare("SELECT * FROM approvals").get();
  const oldSubject = createSqliteTaskApprovalSubjects(s.db).read("task-1", "business");
  const root = s.issues[0];
  if (root === undefined) throw new Error("fixture missing");
  root.body += " changed";
  expect((await s.cli("sync", "--issues", "1")).code).toBe(0);
  expect(s.db.prepare("SELECT * FROM approvals").get()).toEqual(before);
  expect(createSqliteTaskApprovalSubjects(s.db).read("task-1", "business")).not.toEqual(oldSubject);
});

it("sync without Issues only flushes the existing outbox", async () => {
  const s = await setup(false, true);
  const result = await s.cli("sync", "--json");
  expect(result.code).toBe(0);
  expect(s.requests).toEqual([]);
  expect(s.db.prepare("SELECT count(*) AS n FROM task_snapshots").get()).toEqual({ n: 0 });
});

it("imports multiple Issues through IPC, preserves hashes on retry, and refreshes edited content", async () => {
  const s = await setup();
  const first = await s.cli("import-task", "1", "2");
  expect(first.code, first.err).toBe(0);
  expect(first.out).toMatch(/task-1.*content_hash=[a-f0-9]{64}/);
  expect(first.out).toMatch(/task-2.*content_hash=[a-f0-9]{64}/);
  const rows = () => s.db.prepare("SELECT id, content_hash FROM task_snapshots ORDER BY id").all();
  const before = rows();
  expect(before).toHaveLength(2);
  expect((await s.cli("import-task", "1", "2")).out).toContain("unchanged");
  expect(rows()).toEqual(before);
  expect(s.db.prepare("SELECT count(*) AS n FROM events WHERE kind='task.imported'").get()).toEqual(
    { n: 2 },
  );
  const root = s.issues[0];
  if (root === undefined) throw new Error("fixture missing");
  root.body += " changed";
  expect((await s.cli("--json", "import-task", "1")).code).toBe(0);
  expect(rows()).not.toEqual(before);
  expect(s.db.prepare("SELECT count(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  expect(s.calls).toContain("/repos/acme/app/issues/1");
});

it("requests business approval immediately after import using the stored baseline", async () => {
  const s = await setup();
  expect((await s.cli("import-task", "1")).code).toBe(0);
  const result = await s.cli("--json", "approvals", "request", "task-1", "--kind", "business");
  expect(result.code, result.out + result.err).toBe(0);
  const hash = z
    .object({ content_hash: z.string() })
    .parse(
      s.db.prepare("SELECT content_hash FROM task_snapshots WHERE id='task-1'").get(),
    ).content_hash;
  expect(JSON.parse(result.out)).toMatchObject({
    result: { status: "pending", subject: { baselineHash: hash, scopeIds: ["task-1"] } },
  });
});

it("imports and requests business approval across the Unix socket", async () => {
  const s = await setup(true);
  expect((await s.cli("import-task", "1")).code).toBe(0);
  expect((await s.cli("approvals", "request", "task-1", "--kind", "business")).code).toBe(0);
});

it("refuses unimportable requested Issues without storing a partial selection", async () => {
  const s = await setup();
  const result = await s.cli("import-task", "1", "3");
  expect(result.code).toBe(4);
  expect(result.err).toContain("ISSUE_NOT_IMPORTABLE");
  expect(s.db.prepare("SELECT count(*) AS n FROM task_snapshots").get()).toEqual({ n: 0 });
});

it("refuses an archived selected Issue", async () => {
  const s = await setup();
  s.archive();
  expect(await s.cli("import-task", "1")).toMatchObject({ code: 4 });
  expect(s.db.prepare("SELECT count(*) AS n FROM task_snapshots").get()).toEqual({ n: 0 });
});

it("refuses a closed selected Issue even when another selected task depends on it", async () => {
  const s = await setup();
  const root = s.issues[0],
    dependency = s.issues[1];
  if (root === undefined || dependency === undefined) throw new Error("fixture missing");
  root.blockedBy = [dependency.id];
  dependency.state = "CLOSED";
  expect(await s.cli("import-task", "1", "2")).toMatchObject({ code: 4 });
  expect(s.db.prepare("SELECT count(*) AS n FROM task_snapshots").get()).toEqual({ n: 0 });
});

it("reuses an existing repository identity when storing imported tasks", async () => {
  const s = await setup();
  s.db.prepare("INSERT INTO projects VALUES ('existing','acme/app',NULL,'h','t','t')").run();
  const result = await s.cli("--json", "import-task", "1");
  expect(result.code, result.out).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({
    result: { snapshots: [{ taskId: "task-1", outcome: "stored" }] },
  });
  expect(s.db.prepare("SELECT project_id FROM task_snapshots").get()).toEqual({
    project_id: "existing",
  });
  expect(s.db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 1 });
});

it("refuses writes after the runtime loses its lease", async () => {
  const s = await setup();
  s.session.release();
  expect((await s.cli("import-task", "1")).code).toBe(4);
  expect(s.db.prepare("SELECT count(*) AS n FROM task_snapshots").get()).toEqual({ n: 0 });
});
