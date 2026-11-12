import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { projectConfigSchema } from "../../../../src/application/contracts/project-config.ts";
import {
  deployPipelineSchema,
  deployReleaseSchema,
} from "../../../../src/application/contracts/deploy-delivery.ts";
import { openReadOnlyStateDatabase } from "../../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { prepareLocalState } from "../../../../tools/sandbox-setup/local-state.ts";

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
  it("creates a migrated state.db, project row, project.yaml and artifacts directory", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    expect(existsSync(join(stateDir, "artifacts"))).toBe(true);
    const db = openReadOnlyStateDatabase(join(stateDir, "state.db"));
    try {
      expect(db.prepare("SELECT repo_identity FROM projects").all()).toEqual([
        { repo_identity: "omi-hub-services/omi-sandbox" },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()).not.toEqual({ n: 0 });
    } finally {
      db.close();
    }
    const config = projectConfigSchema.parse(
      parse(readFileSync(join(stateDir, "project.yaml"), "utf8")),
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

  it("refuses a state directory for another repository", async () => {
    const stateDir = tempState();
    await prepareLocalState({ ...base, stateDir });
    await expect(
      prepareLocalState({ ...base, stateDir, repository: "omi-hub-services/other-sandbox" }),
    ).rejects.toThrow(/another repository/);
  });
});
