import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeLayout } from "../../../../tools/sandbox-setup/runtime-layout.ts";
import { parse } from "yaml";
import { projectConfigSchema } from "../../../../src/application/contracts/project-config.ts";
import {
  deployPipelineSchema,
  deployReleaseSchema,
} from "../../../../src/application/contracts/deploy-delivery.ts";
import {
  loadRuntimeConfig,
  runtimeConfigHash,
} from "../../../../src/infrastructure/config/load-runtime-config.ts";
import {
  openStateDatabase,
  openReadOnlyStateDatabase,
} from "../../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  assertOutsideDirectory,
  inspectLocalState,
  prepareLocalState,
} from "../../../../tools/sandbox-setup/local-state.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempState = () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-089-state-"));
  dirs.push(dir);
  return join(dir, "state");
};

const base = {
  repository: "omi-hub-services/omi-sandbox",
  projectNumber: 2,
  reviewer: "ttin-omihub",
  now: () => Date.parse("2026-11-12T00:00:00Z"),
  newId: () => "project-1",
};
const deploy = {
  environment: "sandbox",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  approvalId: "deploy-approval-1",
  tag: "sandbox-deploy-r1",
  workflowSha: "c".repeat(40),
  issueNumber: 7,
  authorActor: "minibox-claude-code",
};

describe("sandbox local state", () => {
  it("preserves existing project config bytes when installing missing catalogs", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    const layout = runtimeLayout(stateDir);
    const original = readFileSync(layout.configFile, "utf8") + "# operator comment\n";
    writeFileSync(layout.configFile, original);
    rmSync(join(stateDir, ".omi-squad/config/models.yaml"), { force: true });
    const before = readFileSync(layout.database);
    expect((await inspectLocalState({ ...base, stateDir })).missing).toContain(
      ".omi-squad/config/models.yaml",
    );
    expect(readFileSync(layout.database)).toEqual(before);
    expect(existsSync(join(stateDir, ".omi-squad/config/models.yaml"))).toBe(false);
    await prepareLocalState({ ...base, stateDir });
    expect(readFileSync(layout.configFile, "utf8")).toBe(original);
    expect((await prepareLocalState({ ...base, stateDir })).changed).toEqual([]);
  });

  it("reports a stale project hash without writing and repairs it on apply", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    const layout = runtimeLayout(stateDir);
    const db = openStateDatabase(layout.database);
    db.prepare("UPDATE projects SET config_hash = ?").run("stale");
    db.close();
    const before = readFileSync(layout.database);
    expect((await inspectLocalState({ ...base, stateDir })).missing).toEqual([
      "project config_hash",
    ]);
    expect(readFileSync(layout.database)).toEqual(before);
    expect((await prepareLocalState({ ...base, stateDir })).changed).toEqual([
      "project config_hash",
    ]);
    const reopened = openReadOnlyStateDatabase(layout.database);
    try {
      const config = await loadRuntimeConfig(join(stateDir, ".omi-squad"));
      expect(reopened.prepare("SELECT config_hash FROM projects").get()).toEqual({
        config_hash: runtimeConfigHash(config),
      });
    } finally {
      reopened.close();
    }
    expect((await inspectLocalState({ ...base, stateDir })).missing).toEqual([]);
  });

  it("creates a migrated state.db, project row, project.yaml and artifacts directory", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    expect(existsSync(runtimeLayout(stateDir).artifactsRoot)).toBe(true);
    const db = openReadOnlyStateDatabase(runtimeLayout(stateDir).database);
    try {
      expect(db.prepare("SELECT repo_identity FROM projects").all()).toEqual([
        { repo_identity: "omi-hub-services/omi-sandbox" },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()).not.toEqual({ n: 0 });
    } finally {
      db.close();
    }
    const config = projectConfigSchema.parse(
      parse(readFileSync(runtimeLayout(stateDir).configFile, "utf8")),
    );
    expect(config.policies.github_approval_actors).toEqual(["ttin-omihub"]);
    expect(config.branches).toEqual({ integration: "develop", release: "main" });
  });

  it("changes nothing on a second run", async () => {
    const stateDir = tempState();
    const first = await prepareLocalState({ ...base, stateDir, deploy });
    const second = await prepareLocalState({ ...base, stateDir, deploy });
    expect(first.changed.length).toBeGreaterThan(0);
    expect(second.changed).toEqual([]);
  });

  it("writes harness config the live deploy test accepts, with no credential and no decision", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir, deploy });
    const text = readFileSync(join(stateDir, "deploy-config.json"), "utf8");
    const json = JSON.parse(text) as {
      request: unknown;
      pipeline: unknown;
      stateDirectory: string;
    };
    expect(deployReleaseSchema.parse(json.request)).toMatchObject({
      approvalId: "deploy-approval-1",
    });
    expect(deployPipelineSchema.parse(json.pipeline)).toMatchObject({
      ref: "sandbox-deploy-r1",
      allowedActors: ["ttin-omihub"],
    });
    expect(json.stateDirectory).toBe(stateDir);
    expect(text).not.toMatch(/token|password|secret|approved/i);
  });

  it("writes no harness config until a deploy approval ID is known", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    expect(readdirSync(stateDir)).not.toContain("deploy-config.json");
  });

  it("inspect lists everything missing and writes nothing", async () => {
    const stateDir = tempState();
    const missing = await inspectLocalState({ ...base, stateDir, deploy });
    expect(missing.missing).toEqual(
      expect.arrayContaining([
        "artifacts/",
        "project.yaml",
        "state.db",
        "project row",
        "deploy-config.json",
        ".omi-squad/config/models.yaml",
        ".omi-squad/roles/developer.yaml",
        ".omi-squad/provenance/skills.lock.json",
      ]),
    );
    expect(existsSync(stateDir)).toBe(false);
  });

  it("inspect is empty once prepared, and notices a changed harness config", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir, deploy });
    expect((await inspectLocalState({ ...base, stateDir, deploy })).missing).toEqual([]);
    const other = { ...deploy, issueNumber: 8 };
    expect((await inspectLocalState({ ...base, stateDir, deploy: other })).missing).toEqual([
      "deploy-config.json",
    ]);
  });

  it("adds and updates a deploy target in an existing project.yaml, idempotently, keeping others", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    const target = {
      id: "sandbox-a",
      targetEnvironment: "sandbox",
      artifactDigest: deploy.artifactDigest,
    };
    const other = {
      id: "sandbox-b",
      targetEnvironment: "sandbox",
      artifactDigest: deploy.artifactDigest,
    };
    expect((await prepareLocalState({ ...base, stateDir, deployTarget: target })).changed).toEqual([
      "project.yaml",
      "project config_hash",
    ]);
    await prepareLocalState({ ...base, stateDir, deployTarget: other });
    expect((await prepareLocalState({ ...base, stateDir, deployTarget: target })).changed).toEqual(
      [],
    );
    const moved = { ...target, artifactDigest: `sha256:${"d".repeat(64)}` };
    await prepareLocalState({ ...base, stateDir, deployTarget: moved });
    const config = projectConfigSchema.parse(
      parse(readFileSync(runtimeLayout(stateDir).configFile, "utf8")),
    );
    expect(config.deploy_targets?.map((t) => [t.id, t.artifact_digest])).toEqual([
      ["sandbox-a", moved.artifactDigest],
      ["sandbox-b", other.artifactDigest],
    ]);
    // A later run without a target neither reports the targets as drift nor removes them.
    expect((await inspectLocalState({ ...base, stateDir })).missing).toEqual([]);
    expect((await prepareLocalState({ ...base, stateDir })).changed).toEqual([]);
  });

  it("writes only the runtime layout, nothing at the top level of the directory", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    expect(readdirSync(stateDir)).toEqual([".omi-squad"]);
    const layout = runtimeLayout(stateDir);
    expect(existsSync(layout.configFile)).toBe(true);
    expect(existsSync(layout.database)).toBe(true);
    expect(existsSync(layout.artifactsRoot)).toBe(true);
  });

  // Emulates what an earlier version wrote: everything at the top level of the directory.
  const makeLegacy = async (stateDir: string) => {
    await prepareLocalState({ ...base, stateDir });
    const layout = runtimeLayout(stateDir);
    renameSync(layout.configFile, join(stateDir, "project.yaml"));
    renameSync(layout.database, join(stateDir, "state.db"));
    renameSync(layout.artifactsRoot, join(stateDir, "artifacts"));
    rmSync(join(stateDir, ".omi-squad"), { recursive: true });
  };

  it("lists the legacy move on inspect, writes nothing, then moves it on prepare", async () => {
    const stateDir = tempState();
    await makeLegacy(stateDir);
    const { missing } = await inspectLocalState({ ...base, stateDir });
    expect(missing).toEqual([
      "move project.yaml to .omi-squad/config/project.yaml",
      "move state.db to .omi-squad/local/state/state.sqlite",
      "move artifacts to .omi-squad/local/runs",
    ]);
    expect(existsSync(join(stateDir, "state.db"))).toBe(true);
    expect(existsSync(join(stateDir, ".omi-squad"))).toBe(false);

    const { changed } = await prepareLocalState({ ...base, stateDir });
    expect(changed.slice(0, missing.length)).toEqual(missing);
    expect(changed).toContain(".omi-squad/config/models.yaml");
    expect(readdirSync(stateDir)).toEqual([".omi-squad"]);
    expect((await inspectLocalState({ ...base, stateDir })).missing).toEqual([]);
    const db = openReadOnlyStateDatabase(runtimeLayout(stateDir).database);
    try {
      expect(db.prepare("SELECT repo_identity FROM projects").all()).toHaveLength(1);
    } finally {
      db.close();
    }
    expect((await prepareLocalState({ ...base, stateDir })).changed).toEqual([]);
  });

  it("refuses, and moves nothing, when the legacy and runtime layouts both exist", async () => {
    const stateDir = tempState();
    await makeLegacy(stateDir);
    await prepareLocalState({ ...base, stateDir });
    writeFileSync(join(stateDir, "state.db"), "stray");
    await expect(inspectLocalState({ ...base, stateDir })).rejects.toThrow(
      /both the legacy layout/,
    );
    await expect(prepareLocalState({ ...base, stateDir })).rejects.toThrow(
      /both the legacy layout/,
    );
    expect(readFileSync(join(stateDir, "state.db"), "utf8")).toBe("stray");
  });

  it("rejects a state directory inside the repository, also through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "omi-089-root-"));
    dirs.push(root);
    mkdirSync(join(root, "..foo"));
    symlinkSync(root, join(root, "..foo", "back"));
    expect(() => {
      assertOutsideDirectory(root, join(root, "state"));
    }).toThrow(/outside/);
    expect(() => {
      assertOutsideDirectory(root, join(root, "..foo", "back", "state"));
    }).toThrow(/outside/);
    const elsewhere = mkdtempSync(join(tmpdir(), "omi-089-else-"));
    dirs.push(elsewhere);
    symlinkSync(root, join(elsewhere, "link"));
    expect(() => {
      assertOutsideDirectory(root, join(elsewhere, "link", "state"));
    }).toThrow(/outside/);
    expect(() => {
      assertOutsideDirectory(root, join(elsewhere, "state"));
    }).not.toThrow();
  });

  it("does not mistake a sibling named like the root prefix for inside", () => {
    const parent = mkdtempSync(join(tmpdir(), "omi-089-par-"));
    dirs.push(parent);
    mkdirSync(join(parent, "repo"));
    expect(() => {
      assertOutsideDirectory(join(parent, "repo"), join(parent, "repo-state", "x"));
    }).not.toThrow();
    expect(() => {
      assertOutsideDirectory(join(parent, "repo"), join(parent, "repo", "..foo", "x"));
    }).toThrow(/outside/);
  });

  it("refuses a state directory for another repository", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    await expect(
      prepareLocalState({ ...base, stateDir, repository: "omi-hub-services/other-sandbox" }),
    ).rejects.toThrow(/another repository/);
  });
});
