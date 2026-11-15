import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callCli,
  type BridgeRequest,
} from "../../templates/bridges/claude-code/omi-squad/bridge.ts";
import { createFakeWsl } from "../unit/templates/wsl-fakes.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { createSqliteApprovalStore } from "../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import { createSqliteProfileRegistry } from "../../src/infrastructure/profiles/sqlite-profile-registry.ts";
import { createSqlitePrMappingStore } from "../../src/infrastructure/persistence/sqlite/sqlite-pr-mapping-store.ts";
import { requestApproval } from "../../src/application/use-cases/approvals/request-approval.ts";
import { recordApproval } from "../../src/application/use-cases/approvals/record-approval.ts";

const loader = resolve("tools/register-ts-imports.ts");
const issueBody =
  "## Acceptance criteria\n- [ ] Runtime reaches Done.\n\n## Implementation map\n- `src/bootstrap/runtime.ts`\n- `tests/e2e/`\n\n<!-- omi-squad:plan-key=OMI-070 -->\n";
const resources: {
  directory: string;
  db: StateDatabase;
  child: ChildProcess;
  exit: Promise<number | null>;
}[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.child.stdin?.end("stop\n");
    await resource.exit;
    resource.db.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

function launchRuntime(project: string, mode: string) {
  const child = spawn(
    process.execPath,
    ["--import", loader, resolve("tests/fixtures/runtime/session-process.ts"), project, mode],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  return {
    child,
    exit,
    ready: () =>
      vi.waitFor(
        () => {
          expect(stdout, stderr).toContain("ready\n");
        },
        { timeout: 10000 },
      ),
  };
}

async function setup(mode = "good", approval = true, body = issueBody) {
  const directory = mkdtempSync(join(tmpdir(), "omi-runtime-e2e-"));
  const project = join(directory, "project");
  const squad = join(project, ".omi-squad");
  for (const path of ["config", "roles", "rules", "workflows", "provenance", "local/state"])
    mkdirSync(join(squad, path), { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=develop");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(project, ".gitignore"), ".omi-squad/local/\n");
  writeFileSync(
    join(squad, "config/project.yaml"),
    stringify({
      schema_version: 1,
      repository: { owner: "acme", name: "app" },
      project: { owner: "acme", number: 1 },
      branches: { integration: "develop", release: "main" },
      limits: { max_parallel_workers: 2, step_timeout_seconds: 60, max_rework_cycles: 2 },
      policies: { mandatory_approvals: [] },
      workspace: { worktree_root: join(directory, "omi-wt") },
    }),
  );
  writeFileSync(
    join(squad, "config/models.yaml"),
    stringify({
      schema_version: 1,
      models: {
        worker: { executor: "claude-code", model: "worker", supported_efforts: ["medium", "high"] },
      },
      capability_profiles: { standard: { min_effort: "medium" } },
      verified_models: { standard: ["worker"] },
    }),
  );
  for (const id of ["developer", "reviewer"])
    writeFileSync(
      join(squad, `roles/${id}.yaml`),
      stringify({
        schema_version: 1,
        id,
        version: 1,
        title: id,
        description: id,
        skills: [],
        rules: [],
      }),
    );
  // Rework packets add receiving-code-review, so the project carries the real template skills.
  cpSync(resolve("templates/project/.omi-squad/skills"), join(squad, "skills"), {
    recursive: true,
  });
  copyFileSync(
    resolve("templates/project/.omi-squad/provenance/skills.lock.json"),
    join(squad, "provenance/skills.lock.json"),
  );
  copyFileSync(
    resolve("tests/fixtures/workflows/minimal-delivery.yaml"),
    join(squad, "workflows/minimal-delivery.yaml"),
  );
  writeFileSync(join(directory, "issue.md"), body);
  git("add", ".");
  git("commit", "-m", "seed");
  const db = openStateDatabase(join(squad, "local/state/state.sqlite"));
  applyMigrations(db, loadMigrations(resolve("migrations")));
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('task-142', 'p', 'I_142', 142, ?, ?, '{}', ?)",
  ).run("9".repeat(64), at, at);
  const registry = createSqliteProfileRegistry(db);
  for (const id of mode === "waiting" ? ["p1"] : ["p1", "p2"])
    registry.save(
      {
        profileId: id,
        tool: "claude-code",
        authMode: "subscription",
        credentialRef: join(directory, id),
        accountGroupId: id,
        modelAllowlist: ["worker"],
        state: "ready",
        // In the past on purpose: a probe stamped "now" turns into one from the future, and the
        // profile into NOT_PROBED, when the wall clock steps back between setup and dispatch
        // (WSL2 steps it back 1-2 s). The TTL below is an hour.
        lastProbeAt: Date.now() - 60_000,
        probeTtlMs: 3_600_000,
        maxConcurrency: 1,
        accountGroupMaxConcurrency: 1,
        preference: id === "p1" ? 0 : 1,
      },
      Date.now(),
    );
  if (approval) {
    const unitOfWork = createSqliteStateUnitOfWork(db);
    const shared = {
      unitOfWork,
      now: Date.now,
      nextId: randomUUID,
      subjects: {
        read: () => ({
          kind: "business" as const,
          baselineHash: "9".repeat(64),
          scopeIds: ["task-142"],
        }),
      },
    };
    const requested = requestApproval(shared, {
      schemaVersion: 1,
      subjectId: "task-142",
      kind: "business",
    });
    if (!requested.ok) throw new Error(requested.reason);
    const decided = await recordApproval(
      {
        ...shared,
        store: createSqliteApprovalStore(db),
        allowedGitHubActors: [],
        source: {
          verify: (request) =>
            Promise.resolve({
              approvalId: request.id,
              version: request.version,
              subjectHash: request.subjectHash,
              decision: "approved",
              actor: "fixture-po",
              source: "po-cli",
              evidenceRef: "fixture-confirmation",
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
    if (!decided.ok) throw new Error(decided.reason);
  }
  createSqlitePrMappingStore(db).save({
    projectId: "p",
    taskId: "task-142",
    repository: "acme/app",
    issueNumber: 142,
    prNumber: 143,
  });
  let active = launchRuntime(project, mode);
  const resource = { directory, db, child: active.child, exit: active.exit };
  resources.push(resource);
  await active.ready();
  const restart = async () => {
    active.child.stdin.end("stop\n");
    expect(await active.exit).toBe(0);
    active = launchRuntime(project, mode);
    resource.child = active.child;
    resource.exit = active.exit;
    await active.ready();
  };
  const socketPath = join(squad, "local/ipc/runtime.sock");
  const wsl = createFakeWsl((call) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        loader,
        resolve("src/bootstrap/cli.ts"),
        "--socket",
        socketPath,
        ...call.cliArgs,
      ],
      { cwd: project, input: call.stdin, encoding: "utf8", timeout: 10000 },
    );
    return Promise.resolve({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status ?? 1,
    });
  });
  const bridge = (request: BridgeRequest) =>
    callCli({ distribution: "Ubuntu", repository: project, shim: `${squad}/bin/omi` }, request, {
      spawn: wsl.spawn,
      platform: "win32",
    });
  const ok = async (request: BridgeRequest) => {
    const response = await bridge(request);
    if (!response.ok) throw new Error(JSON.stringify(response));
    return z.record(z.string(), z.unknown()).parse(response.result);
  };
  const plan = await ok({ command: "plan", issueNumber: 142, workflowId: "minimal-delivery" });
  const runId = z.string().parse(plan["runId"]);
  const dispatch = async (stepId: string) => {
    await ok({ command: "dispatch", runId, stepId });
    return ok({ command: "wait", runId, timeoutSeconds: 5 });
  };
  return {
    directory,
    project,
    db,
    get child() {
      return active.child;
    },
    get exit() {
      return active.exit;
    },
    bridge,
    ok,
    runId,
    dispatch,
    restart,
  };
}

describe("bridge against the real session runtime process", () => {
  it("hands off an approved planned run before its first dispatch", async () => {
    const s = await setup();
    expect(await s.ok({ command: "handoff", reason: "new-session" })).toMatchObject({
      paused: [{ runId: s.runId }],
    });
    expect(
      await s.ok({ command: "handoff", reason: "profile-switch", toProfile: "alternate" }),
    ).toMatchObject({ alreadyStopped: [s.runId] });
  }, 15000);
  it("stops an owned worker on session exit and resumes it as a fresh persisted attempt after restart", async () => {
    const s = await setup("slow");
    await s.ok({ command: "dispatch", runId: s.runId, stepId: "implement" });
    await s.restart();
    await s.ok({ command: "resume", runId: s.runId });
    await s.ok({ command: "wait", runId: s.runId, timeoutSeconds: 5 });
    expect(s.db.prepare("SELECT status FROM agent_attempts ORDER BY attempt_number").all()).toEqual(
      [{ status: "interrupted" }, { status: "succeeded" }],
    );
    expect(s.db.prepare("SELECT failure_count FROM workflow_runs WHERE id=?").get(s.runId)).toEqual(
      { failure_count: 0 },
    );
  }, 20000);
  it("serves every run command and drives plan, work, independent review, and delivery to Done", async () => {
    const s = await setup();
    await s.dispatch("implement");
    expect(await s.ok({ command: "status", runId: s.runId })).toMatchObject({
      run: { status: "running" },
    });
    await s.ok({ command: "pause", runId: s.runId, reason: "checkpoint handoff" });
    await s.restart();
    expect(await s.ok({ command: "status", runId: s.runId })).toMatchObject({
      run: { status: "paused" },
    });
    await s.ok({ command: "resume", runId: s.runId });
    await s.ok({ command: "wait", runId: s.runId, timeoutSeconds: 5 });
    const head = z
      .object({ head: z.string() })
      .parse(
        s.db
          .prepare(
            "SELECT json_extract(payload, '$.result.revision.headSha') AS head FROM events WHERE kind='step.succeeded' ORDER BY sequence DESC LIMIT 1",
          )
          .get(),
      ).head;
    expect(
      await s.ok({
        command: "deliver",
        runId: s.runId,
        prNumber: 143,
        reviewedHeadSha: head,
        requiredChecks: ["ci"],
      }),
    ).toMatchObject({ status: "done" });
    expect(await s.ok({ command: "status", runId: s.runId })).toMatchObject({
      run: { status: "succeeded" },
    });
    await s.ok({ command: "handoff", reason: "new-session" });
    await s.ok({ command: "handoff", reason: "profile-switch", toProfile: "other-profile" });
    expect(
      s.db.prepare("SELECT count(*) AS count FROM events WHERE kind='task.done'").get(),
    ).toEqual({ count: 1 });
    const remote = z
      .object({
        issues: z.array(z.object({ state: z.string(), body: z.string() })),
        pulls: z.array(z.object({ merged: z.boolean() })),
      })
      .parse(JSON.parse(readFileSync(join(s.directory, "fake-github.json"), "utf8")));
    expect(remote.issues[0]?.state).toBe("closed");
    expect(remote.issues[0]?.body).toContain("- [x] Runtime reaches Done.");
    expect(remote.pulls[0]?.merged).toBe(true);
    expect(s.db.prepare("SELECT dispatch_record FROM agent_attempts").all()).toHaveLength(2);
    expect(
      s.db
        .prepare("SELECT relative_path FROM artifacts WHERE classification='context-packet'")
        .all(),
    ).toHaveLength(2);
    expect(readFileSync(join(s.directory, "omi-wt/omi-070/result.txt"), "utf8")).toBe(
      "implemented\n",
    );
    s.child.stdin.end("stop\n");
    expect(await s.exit).toBe(0);
  }, 20000);
  it.each([
    ["", true, "IMPLEMENTATION_MAP_EMPTY"],
    [issueBody, false, "BUSINESS_APPROVAL_REQUIRED"],
  ])(
    "refuses a missing dispatch authority with a typed bridge reason",
    async (body, approval, reason) => {
      const s = await setup("good", approval, body);
      expect(
        await s.bridge({ command: "dispatch", runId: s.runId, stepId: "implement" }),
      ).toMatchObject({ ok: false, code: "COMMAND_REFUSED", message: reason });
      expect(s.db.prepare("SELECT count(*) AS count FROM agent_attempts").get()).toEqual({
        count: 0,
      });
    },
    15000,
  );
  it("refuses dispatch of a revision whose approval pins an older Issue hash, creating no attempt or worktree", async () => {
    const s = await setup();
    // Re-import changed the content hash after the business approval was decided.
    s.db
      .prepare("UPDATE task_snapshots SET content_hash=? WHERE id='task-142'")
      .run("8".repeat(64));
    expect(
      await s.bridge({ command: "dispatch", runId: s.runId, stepId: "implement" }),
    ).toMatchObject({ ok: false, code: "COMMAND_REFUSED", message: "BUSINESS_APPROVAL_STALE" });
    expect(s.db.prepare("SELECT count(*) AS count FROM agent_attempts").get()).toEqual({
      count: 0,
    });
    expect(existsSync(join(s.directory, "omi-wt/omi-070"))).toBe(false);
  }, 15000);
  it("refuses to resume a run whose business approval went stale while it was paused", async () => {
    const s = await setup("slow");
    await s.ok({ command: "dispatch", runId: s.runId, stepId: "implement" });
    await s.restart();
    s.db
      .prepare("UPDATE task_snapshots SET content_hash=? WHERE id='task-142'")
      .run("8".repeat(64));
    const resumed = await s.bridge({ command: "resume", runId: s.runId });
    expect(resumed).toMatchObject({ ok: false });
    expect(JSON.stringify(resumed)).toContain("BUSINESS_APPROVAL_STALE");
    expect(s.db.prepare("SELECT status FROM agent_attempts").all()).toEqual([
      { status: "interrupted" },
    ]);
  }, 20000);
  it("routes a usage limit through failover, reuses the checkpoint and dispatches a new profile without spending quality budget", async () => {
    const s = await setup("failover");
    await s.dispatch("implement");
    expect(
      s.db.prepare("SELECT status, profile_id FROM agent_attempts ORDER BY attempt_number").all(),
    ).toEqual([
      { status: "interrupted", profile_id: "p1" },
      { status: "succeeded", profile_id: "p2" },
    ]);
    expect(s.db.prepare("SELECT failure_count FROM workflow_runs WHERE id=?").get(s.runId)).toEqual(
      { failure_count: 0 },
    );
    expect(
      s.db.prepare("SELECT kind FROM events WHERE kind='step.waiting_resource'").all(),
    ).toHaveLength(1);
  }, 15000);
  it("keeps a resource-starved step waiting and its run running", async () => {
    const s = await setup("waiting");
    await s.dispatch("implement");
    expect(await s.ok({ command: "status", runId: s.runId })).toMatchObject({
      run: { status: "running", steps: [{ status: "waiting_resource" }, { status: "pending" }] },
    });
  }, 15000);
  it("routes quality failure through the persisted rework controller and authorizes a fresh attempt", async () => {
    const s = await setup("quality");
    await s.dispatch("implement");
    expect(s.db.prepare("SELECT failure_count FROM workflow_runs WHERE id=?").get(s.runId)).toEqual(
      { failure_count: 1 },
    );
    expect(s.db.prepare("SELECT kind FROM events WHERE kind='rework.retry'").all()).toHaveLength(1);
    await s.dispatch("implement");
    expect(s.db.prepare("SELECT status FROM agent_attempts ORDER BY attempt_number").all()).toEqual(
      [{ status: "failed" }, { status: "succeeded" }],
    );
  }, 15000);
});
