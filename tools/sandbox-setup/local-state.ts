// Local, idempotent state for the OMI-042 live harness (OMI-089): a dedicated directory with a
// migrated state.db, the project row, project.yaml, artifacts/ and the harness config JSON.
// It holds no credential and records no approval; decisions go through the runtime lifecycle.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  deployPipelineSchema,
  deployReleaseSchema,
} from "../../src/application/contracts/deploy-delivery.ts";
import { projectConfigSchema } from "../../src/application/contracts/project-config.ts";
import type { ProjectConfig } from "../../src/application/contracts/project-config.ts";
import { createProjectConfigStore } from "../../src/infrastructure/config/project-config-store.ts";
import {
  MIGRATION_HISTORY_TABLE,
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openReadOnlyStateDatabase,
  openStateDatabase,
} from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

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

const defaultMigrations = (input: LocalStateInput) =>
  input.migrationsDir ?? resolve(import.meta.dirname, "../../migrations");

function desiredConfig(input: LocalStateInput): ProjectConfig {
  const [owner = "", name = ""] = input.repository.split("/");
  return projectConfigSchema.parse({
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
}

function deployConfigText(input: LocalStateInput, deploy: DeployFacts): string {
  return `${JSON.stringify(
    {
      request: deployReleaseSchema.parse({
        repository: input.repository,
        environment: deploy.environment,
        artifactDigest: deploy.artifactDigest,
        approvalId: deploy.approvalId,
      }),
      pipeline: deployPipelineSchema.parse({
        workflow: "sandbox-deploy.yml",
        ref: deploy.tag,
        workflowSha: deploy.workflowSha,
        issueNumber: deploy.issueNumber,
        allowedActors: [input.reviewer],
        authorActor: deploy.authorActor,
      }),
      stateDirectory: resolve(input.stateDir),
    },
    null,
    2,
  )}\n`;
}

/**
 * Rejects a state directory inside `root`. Both paths are resolved through symlinks (the deepest
 * existing ancestor is resolved, the rest appended) and compared by path segments, so a sibling
 * such as `root-state` or a directory named `..foo` inside `root` is judged correctly.
 */
export function assertOutsideDirectory(root: string, target: string): void {
  const real = (path: string): string => {
    const absolute = resolve(path);
    try {
      return realpathSync(absolute);
    } catch {
      return join(real(dirname(absolute)), basename(absolute));
    }
  };
  const rel = relative(real(root), real(target));
  const climbsOut = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!climbsOut) throw new Error("--state-dir must be outside this repository");
}

/** Read-only: what `prepareLocalState` would create or rewrite. Writes nothing, not even the directory. */
export async function inspectLocalState(input: LocalStateInput): Promise<{ missing: string[] }> {
  const missing: string[] = [];
  const stateDir = resolve(input.stateDir);
  if (!existsSync(join(stateDir, "artifacts"))) missing.push("artifacts/");

  let configOk = false;
  if (existsSync(stateDir)) {
    const current = await (await createProjectConfigStore(stateDir)).read();
    configOk = JSON.stringify(current) === JSON.stringify(desiredConfig(input));
  }
  if (!configOk) missing.push("project.yaml");

  const databasePath = join(stateDir, "state.db");
  let migrated = false;
  let hasProject = false;
  if (existsSync(databasePath)) {
    const db = openReadOnlyStateDatabase(databasePath);
    try {
      const table = db
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE name = ?")
        .get(MIGRATION_HISTORY_TABLE);
      if (table !== undefined) {
        const applied = db
          .prepare(`SELECT count(*) AS n FROM ${MIGRATION_HISTORY_TABLE}`)
          .get() as {
          n: number;
        };
        migrated = applied.n === loadMigrations(defaultMigrations(input)).length;
        const rows = db.prepare("SELECT repo_identity FROM projects").all() as {
          repo_identity: string;
        }[];
        if (rows.some((p) => p.repo_identity !== input.repository))
          throw new Error("state directory belongs to another repository; use a new --state-dir");
        hasProject = rows.length > 0;
      }
    } finally {
      db.close();
    }
  }
  if (!migrated) missing.push("state.db");
  if (!hasProject) missing.push("project row");

  if (input.deploy !== undefined) {
    const path = join(stateDir, "deploy-config.json");
    if (!existsSync(path) || readFileSync(path, "utf8") !== deployConfigText(input, input.deploy))
      missing.push("deploy-config.json");
  }
  return { missing };
}

/** `changed` names what this run created or rewrote; empty on a repeat run. */
export async function prepareLocalState(input: LocalStateInput): Promise<{ changed: string[] }> {
  const changed: string[] = [];
  const stateDir = resolve(input.stateDir);

  mkdirSync(stateDir, { recursive: true });
  const artifacts = join(stateDir, "artifacts");
  if (!existsSync(artifacts)) {
    mkdirSync(artifacts);
    changed.push("artifacts/");
  }

  const config = desiredConfig(input);
  if ((await (await createProjectConfigStore(stateDir)).create(config)) === "created")
    changed.push("project.yaml");

  const databasePath = join(stateDir, "state.db");
  const created = !existsSync(databasePath);
  const db = openStateDatabase(databasePath);
  try {
    const migrations = loadMigrations(defaultMigrations(input));
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
    const text = deployConfigText(input, input.deploy);
    const path = join(stateDir, "deploy-config.json");
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      writeFileSync(path, text, { mode: 0o600 });
      changed.push("deploy-config.json");
    }
  }
  return { changed };
}
