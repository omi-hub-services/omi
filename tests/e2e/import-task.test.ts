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

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(socket = false) {
  const directory = mkdtempSync(join(tmpdir(), "omi-import-"));
  const squad = join(directory, ".omi-squad");
  for (const name of ["config", "roles", "rules", "workflows", "provenance"])
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
  const transport = {
    send(request: import("../../src/infrastructure/github/github-transport.ts").HttpRequest) {
      calls.push(request.path);
      let data: unknown;
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
    archive: () => {
      archived = true;
    },
  };
}

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
