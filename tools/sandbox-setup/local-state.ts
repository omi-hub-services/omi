// Local, idempotent state for the OMI-042 live harness (OMI-089): a dedicated directory with a
// migrated state.db, the project row, project.yaml, artifacts/ and the harness config JSON.
// It holds no credential and records no approval; decisions go through the runtime lifecycle.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  deployPipelineSchema,
  deployReleaseSchema,
} from "../../src/application/contracts/deploy-delivery.ts";
import { projectConfigSchema } from "../../src/application/contracts/project-config.ts";
import { createProjectConfigStore } from "../../src/infrastructure/config/project-config-store.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { openStateDatabase } from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

export interface DeployFacts {
  readonly environment: string;
  readonly artifactDigest: string;
  /** The durable deploy approval the PO decides; never created by this script. */
  readonly approvalId: string;
  readonly tag: string;
  readonly workflowSha: string;
  readonly issueNumber: number;
  readonly authorActor: string;
}

export interface LocalStateInput {
  readonly stateDir: string;
  readonly repository: string;
  readonly projectNumber: number;
  readonly reviewer: string;
  readonly now: () => number;
  readonly newId: () => string;
  readonly deploy?: DeployFacts;
  readonly migrationsDir?: string;
}

/** `changed` names what this run created or rewrote; empty on a repeat run. */
export async function prepareLocalState(input: LocalStateInput): Promise<{ changed: string[] }> {
  const changed: string[] = [];
  const stateDir = resolve(input.stateDir);
  const [owner = "", name = ""] = input.repository.split("/");

  mkdirSync(stateDir, { recursive: true });
  const artifacts = join(stateDir, "artifacts");
  if (!existsSync(artifacts)) {
    mkdirSync(artifacts);
    changed.push("artifacts/");
  }

  const config = projectConfigSchema.parse({
    schema_version: 1,
    repository: { owner, name },
    project: { owner, number: input.projectNumber },
    branches: { integration: "develop", release: "main" },
    limits: { max_parallel_workers: 1, step_timeout_seconds: 3600, max_rework_cycles: 2 },
    policies: {
      mandatory_approvals: ["release", "deploy"],
      github_approval_actors: [input.reviewer],
    },
  });
  if ((await (await createProjectConfigStore(stateDir)).create(config)) === "created")
    changed.push("project.yaml");

  const databasePath = join(stateDir, "state.db");
  const created = !existsSync(databasePath);
  const db = openStateDatabase(databasePath);
  try {
    const migrations = loadMigrations(
      input.migrationsDir ?? resolve(import.meta.dirname, "../../migrations"),
    );
    const applied = applyMigrations(db, migrations).applied.length;
    if (created || applied > 0) changed.push("state.db");
    const projects = db.prepare("SELECT repo_identity FROM projects").all() as {
      repo_identity: string;
    }[];
    if (projects.some((p) => p.repo_identity !== input.repository))
      throw new Error("state directory belongs to another repository; use a new --state-dir");
    if (projects.length === 0) {
      const at = new Date(input.now()).toISOString();
      const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
      db.prepare(
        "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(input.newId(), input.repository, hash, at, at);
      changed.push("project row");
    }
  } finally {
    db.close();
  }

  if (input.deploy !== undefined) {
    const d = input.deploy;
    const text = `${JSON.stringify(
      {
        request: deployReleaseSchema.parse({
          repository: input.repository,
          environment: d.environment,
          artifactDigest: d.artifactDigest,
          approvalId: d.approvalId,
        }),
        pipeline: deployPipelineSchema.parse({
          workflow: "sandbox-deploy.yml",
          ref: d.tag,
          workflowSha: d.workflowSha,
          issueNumber: d.issueNumber,
          allowedActors: [input.reviewer],
          authorActor: d.authorActor,
        }),
        stateDirectory: stateDir,
      },
      null,
      2,
    )}\n`;
    const path = join(stateDir, "deploy-config.json");
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      writeFileSync(path, text, { mode: 0o600 });
      changed.push("deploy-config.json");
    }
  }
  return { changed };
}
