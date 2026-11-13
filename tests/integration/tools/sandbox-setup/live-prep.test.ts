import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeLayout } from "../../../../tools/sandbox-setup/runtime-layout.ts";
import {
  loadRuntimeConfig,
  runtimeConfigHash,
} from "../../../../src/infrastructure/config/load-runtime-config.ts";
import { requestApproval } from "../../../../src/application/use-cases/approvals/request-approval.ts";
import type { GithubTaskReader } from "../../../../src/application/ports/github-task-reader.ts";
import { sha256ContentHasher } from "../../../../src/infrastructure/artifacts/sha256-content-hasher.ts";
import { createSqliteStateUnitOfWork } from "../../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import {
  openReadOnlyStateDatabase,
  openStateDatabase,
} from "../../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { prepareLocalState } from "../../../../tools/sandbox-setup/local-state.ts";
import { runLivePrep, type LivePrepDeps } from "../../../../tools/sandbox-setup/live-prep.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repository = "omi-hub-services/omi-sandbox";
const digest = `sha256:${"b".repeat(64)}`;
const issue = {
  id: "I_kwDOtask7",
  number: 7,
  repository: { owner: "omi-hub-services", name: "omi-sandbox" },
  title: "Acceptance task",
  body: "## Acceptance criteria\n- [ ] x",
  state: "OPEN" as const,
  updatedAt: "2026-11-12T00:00:00Z",
  milestoneId: null,
  blockedBy: [],
};
const reader: GithubTaskReader = {
  items: () =>
    Promise.resolve([
      { id: "PVTI_1", kind: "Issue", issueId: issue.id, archived: false, iterations: [] },
    ]),
  issue: () => Promise.resolve(issue),
};
const base = {
  repository,
  projectNumber: 2,
  reviewer: "ttin-omihub",
  now: () => Date.parse("2026-11-12T00:00:00Z"),
  newId: () => "project-1",
};

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "omi-042-prep-"));
  dirs.push(root);
  const stateDir = join(root, "state");
  await prepareLocalState({ ...base, stateDir });
  let n = 0;
  const deps: LivePrepDeps = {
    ...base,
    root: join(root, "repo"),
    environment: "sandbox",
    artifactDigest: digest,
    projectNodeId: "PVT_kwDOproject",
    issueNodeId: () => Promise.resolve(issue.id),
    reader,
    hasher: sha256ContentHasher,
    newId: () => `id-${String((n += 1))}`,
    pipeline: {
      workflow: "sandbox-deploy.yml",
      ref: "sandbox-deploy-r1",
      workflowSha: "c".repeat(40),
      issueNumber: 3,
      allowedActors: ["ttin-omihub"],
      authorActor: "minibox-claude-code",
    },
  };
  const flags = { stateDir, acceptanceId: "acceptance-042-a", issue: 7, dryRun: false };
  return { stateDir, deps, flags };
}

const query = <T>(stateDir: string, sql: string): T[] => {
  const db = openReadOnlyStateDatabase(runtimeLayout(stateDir).database);
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};
const liveConfig = (stateDir: string) =>
  JSON.parse(readFileSync(join(stateDir, "live-lifecycle-config.json"), "utf8")) as Record<
    string,
    unknown
  >;

describe("live-prep", () => {
  it("loads runtime catalogs and opens the prepared runtime state without GitHub", async () => {
    const { stateDir, deps, flags } = await setup();
    await runLivePrep(deps, flags);
    const config = await loadRuntimeConfig(join(stateDir, ".omi-squad"));
    expect(config.workflows.byId("feature")).toBeDefined();
    expect(query(stateDir, "SELECT config_hash FROM projects")).toEqual([
      { config_hash: runtimeConfigHash(config) },
    ]);
    expect(config.catalog.roles.length).toBeGreaterThan(0);
    expect(query(stateDir, "SELECT id FROM projects")).toEqual([{ id: "project-1" }]);
  });

  it("stores the task snapshot, adds the deploy target and writes the config without any approval", async () => {
    const { stateDir, deps, flags } = await setup();
    const result = await runLivePrep(deps, flags);
    expect(result.code).toBe(0);
    const rows = query<{ id: string; content_hash: string }>(
      stateDir,
      "SELECT id, content_hash FROM task_snapshots",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("task-7");
    expect(readFileSync(runtimeLayout(stateDir).configFile, "utf8")).toContain(
      "target_environment: sandbox",
    );
    const config = liveConfig(stateDir);
    expect(config).toMatchObject({
      taskId: "task-7",
      baselineHash: rows[0]?.content_hash,
      artifactDigest: digest,
      projectId: "project-1",
    });
    expect(query(stateDir, "SELECT id FROM approvals")).toEqual([]);
    expect(result.lines.join("\n")).toContain("approvals request task-7 --kind business");
  });

  it("is idempotent: a rerun changes no file and writes no new event", async () => {
    const { stateDir, deps, flags } = await setup();
    await runLivePrep(deps, flags);
    const files = [
      runtimeLayout(stateDir).configFile,
      join(stateDir, "live-lifecycle-config.json"),
    ].map((f) => readFileSync(f, "utf8"));
    const events = query(stateDir, "SELECT sequence FROM events");
    await runLivePrep(deps, flags);
    expect(
      [runtimeLayout(stateDir).configFile, join(stateDir, "live-lifecycle-config.json")].map((f) =>
        readFileSync(f, "utf8"),
      ),
    ).toEqual(files);
    expect(query(stateDir, "SELECT sequence FROM events")).toEqual(events);
  });

  it("writes nothing on --dry-run", async () => {
    const { stateDir, deps, flags } = await setup();
    const before = readFileSync(runtimeLayout(stateDir).configFile, "utf8");
    const result = await runLivePrep(deps, { ...flags, dryRun: true });
    expect(result.lines.join("\n")).toContain("DRY RUN");
    expect(query(stateDir, "SELECT id FROM task_snapshots")).toEqual([]);
    expect(existsSync(join(stateDir, "live-lifecycle-config.json"))).toBe(false);
    expect(readFileSync(runtimeLayout(stateDir).configFile, "utf8")).toBe(before);
  });

  it("refuses a state directory that is not prepared or lies inside the repository", async () => {
    const { deps, flags } = await setup();
    const fresh = join(mkdtempSync(join(tmpdir(), "omi-042-empty-")), "state");
    dirs.push(fresh);
    await expect(runLivePrep(deps, { ...flags, stateDir: fresh })).rejects.toThrow(
      /local state incomplete/,
    );
    await expect(runLivePrep({ ...deps, root: flags.stateDir }, flags)).rejects.toThrow(
      /outside this repository/,
    );
  });

  it("refuses a directory still in the legacy top-level layout, and does not move it", async () => {
    const { stateDir, deps, flags } = await setup();
    const layout = runtimeLayout(stateDir);
    renameSync(layout.configFile, join(stateDir, "project.yaml"));
    renameSync(layout.database, join(stateDir, "state.db"));
    renameSync(layout.artifactsRoot, join(stateDir, "artifacts"));
    rmSync(join(stateDir, ".omi-squad"), { recursive: true });
    await expect(runLivePrep(deps, flags)).rejects.toThrow(
      /local state incomplete \(move project\.yaml .*move state\.db to \.omi-squad\/local\/state\/state\.sqlite/,
    );
    expect(existsSync(join(stateDir, "state.db"))).toBe(true);
  });

  it("refuses an Issue that is not an importable item of the sandbox Project", async () => {
    const { deps, flags } = await setup();
    await expect(
      runLivePrep({ ...deps, reader: { ...reader, items: () => Promise.resolve([]) } }, flags),
    ).rejects.toThrow(/not an importable item/);
  });

  it("fills in a pending approval id after verifying its subject, and leaves it pending", async () => {
    const { stateDir, deps, flags } = await setup();
    await runLivePrep(deps, flags);
    const baselineHash = liveConfig(stateDir)["baselineHash"] as string;
    const db = openStateDatabase(runtimeLayout(stateDir).database);
    let requested;
    try {
      requested = requestApproval(
        {
          subjects: {
            read: () => ({ kind: "business", baselineHash, scopeIds: ["task-7"] }),
          },
          unitOfWork: createSqliteStateUnitOfWork(db),
          now: Date.now,
          nextId: (() => {
            let i = 0;
            return () => `req-${String((i += 1))}`;
          })(),
        },
        { schemaVersion: 1, subjectId: "task-7", kind: "business" },
      );
    } finally {
      db.close();
    }
    expect(requested.ok).toBe(true);
    const id = requested.ok ? requested.request.id : "";
    await runLivePrep(deps, { ...flags, businessApprovalId: id });
    expect(liveConfig(stateDir)["businessApprovalId"]).toBe(id);
    expect(query<{ status: string }>(stateDir, "SELECT status FROM approvals")).toEqual([
      { status: "pending" },
    ]);
  });

  it("refuses an approval id that does not exist or names another subject", async () => {
    const { stateDir, deps, flags } = await setup();
    await runLivePrep(deps, flags);
    await expect(runLivePrep(deps, { ...flags, businessApprovalId: "missing" })).rejects.toThrow(
      /business approval missing not found/,
    );
    const db = openStateDatabase(runtimeLayout(stateDir).database);
    let id = "";
    try {
      const made = requestApproval(
        {
          subjects: {
            read: () => ({ kind: "business", baselineHash: "f".repeat(64), scopeIds: ["task-7"] }),
          },
          unitOfWork: createSqliteStateUnitOfWork(db),
          now: Date.now,
          nextId: (() => {
            let i = 0;
            return () => `other-${String((i += 1))}`;
          })(),
        },
        { schemaVersion: 1, subjectId: "task-7", kind: "business" },
      );
      if (made.ok) id = made.request.id;
    } finally {
      db.close();
    }
    await expect(runLivePrep(deps, { ...flags, businessApprovalId: id })).rejects.toThrow(
      /does not match/,
    );
  });

  // The runtime builds this subject from project.yaml deploy_targets (ADR-0037).
  const requestDeploy = (stateDir: string, artifactDigest: string): string => {
    const db = openStateDatabase(runtimeLayout(stateDir).database);
    try {
      const made = requestApproval(
        {
          subjects: {
            read: () => ({ kind: "deploy", artifactDigest, environment: "sandbox" }),
          },
          unitOfWork: createSqliteStateUnitOfWork(db),
          now: Date.now,
          nextId: (() => {
            let i = 0;
            return () => `deploy-${artifactDigest.slice(-4)}-${String((i += 1))}`;
          })(),
        },
        { schemaVersion: 1, subjectId: "sandbox-acceptance-042-a", kind: "deploy" },
      );
      if (!made.ok) throw new Error("fixture request failed");
      return made.request.id;
    } finally {
      db.close();
    }
  };

  it("fills in a pending deploy approval id after verifying its subject, and leaves it pending", async () => {
    const { stateDir, deps, flags } = await setup();
    await runLivePrep(deps, flags);
    const id = requestDeploy(stateDir, digest);
    const result = await runLivePrep(deps, { ...flags, deployApprovalId: id });
    expect(liveConfig(stateDir)["deployApprovalId"]).toBe(id);
    expect(result.lines.join("\n")).toContain(`deploy approval ${id}: pending`);
    expect(query<{ status: string }>(stateDir, "SELECT status FROM approvals")).toEqual([
      { status: "pending" },
    ]);
  });

  it("refuses a deploy approval for another digest", async () => {
    const { stateDir, deps, flags } = await setup();
    await runLivePrep(deps, flags);
    const id = requestDeploy(stateDir, `sha256:${"e".repeat(64)}`);
    await expect(runLivePrep(deps, { ...flags, deployApprovalId: id })).rejects.toThrow(
      /deploy approval .* does not match/,
    );
  });
});
