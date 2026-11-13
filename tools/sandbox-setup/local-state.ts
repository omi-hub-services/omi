// Local, idempotent state for the OMI-042 live harness (OMI-089): a dedicated directory that is the
// runtime's projectDir. Files sit where the runtime reads them (runtime-layout.ts): a migrated
// state database, the project row, project.yaml and the artifact root; the harness config JSON
// stays at the top level. An earlier top-level layout is moved into place (or refused).
// It holds no credential and records no approval; decisions go through the runtime lifecycle.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
import {
  applyLayoutMigration,
  describeMove,
  planLayoutMigration,
  runtimeLayout,
} from "./runtime-layout.ts";

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

/** A `deploy_targets` entry of project.yaml (ADR-0037); the trusted source of the deploy subject. */
export interface DeployTargetFacts {
  readonly id: string;
  readonly targetEnvironment: string;
  readonly artifactDigest: string;
}

export interface LocalStateInput {
  readonly stateDir: string;
  readonly repository: string;
  readonly projectNumber: number;
  readonly reviewer: string;
  readonly now: () => number;
  readonly newId: () => string;
  readonly deploy?: DeployFacts;
  /** Added to (or updated in) project.yaml's `deploy_targets`; other entries are kept. */
  readonly deployTarget?: DeployTargetFacts;
  readonly migrationsDir?: string;
}

const defaultMigrations = (input: LocalStateInput) =>
  input.migrationsDir ?? resolve(import.meta.dirname, "../../migrations");

function desiredConfig(input: LocalStateInput, current?: ProjectConfig): ProjectConfig {
  const [owner = "", name = ""] = input.repository.split("/");
  const target = input.deployTarget;
  const entry =
    target === undefined
      ? undefined
      : {
          id: target.id,
          target_environment: target.targetEnvironment,
          artifact_digest: target.artifactDigest,
        };
  const known = current?.deploy_targets ?? [];
  const targets =
    entry === undefined
      ? undefined
      : known.some((t) => t.id === entry.id)
        ? known.map((t) => (t.id === entry.id ? entry : t))
        : [...known, entry];
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
    ...(targets === undefined ? {} : { deploy_targets: targets }),
  });
}

const withoutTargets = (config: ProjectConfig): string =>
  JSON.stringify({ ...config, deploy_targets: undefined });

/** Without a target in the input, targets already in the file are not this script's concern. */
function configMatches(current: ProjectConfig, input: LocalStateInput): boolean {
  const desired = desiredConfig(input, current);
  return input.deployTarget === undefined
    ? withoutTargets(current) === withoutTargets(desired)
    : JSON.stringify(current) === JSON.stringify(desired);
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
  const layout = runtimeLayout(stateDir);
  const moves = planLayoutMigration(stateDir);
  if (moves.length > 0) return { missing: moves.map((move) => describeMove(stateDir, move)) };
  if (!existsSync(layout.artifactsRoot)) missing.push("artifacts/");

  let configOk = false;
  if (existsSync(layout.configDir)) {
    const current = await (await createProjectConfigStore(layout.configDir)).read();
    configOk = current !== undefined && configMatches(current, input);
  }
  if (!configOk) missing.push("project.yaml");

  const databasePath = layout.database;
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
  const layout = runtimeLayout(stateDir);
  // Before anything is created, so a directory holding both layouts is refused untouched.
  const moves = planLayoutMigration(stateDir);
  applyLayoutMigration(moves);
  changed.push(...moves.map((move) => describeMove(stateDir, move)));
  if (!existsSync(layout.artifactsRoot)) {
    mkdirSync(layout.artifactsRoot, { recursive: true });
    changed.push("artifacts/");
  }

  mkdirSync(layout.configDir, { recursive: true });
  const configStore = await createProjectConfigStore(layout.configDir);
  if ((await configStore.create(desiredConfig(input))) === "created") changed.push("project.yaml");
  else {
    const current = await configStore.read();
    // shortcut: the store only creates; unlink + create is not atomic, fine for a local operator tool.
    if (
      input.deployTarget !== undefined &&
      current !== undefined &&
      !configMatches(current, input) &&
      withoutTargets(current) === withoutTargets(desiredConfig(input, current))
    ) {
      const next = desiredConfig(input, current);
      unlinkSync(layout.configFile);
      await configStore.create(next);
      changed.push("project.yaml");
    }
  }
  const config = desiredConfig(input);

  const databasePath = layout.database;
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
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
