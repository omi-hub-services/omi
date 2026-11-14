// Prepares the OMI-042 live acceptance run (AC-3) in a dedicated state directory:
//   1. imports the sandbox task Issue into the runtime state database (importTask + storeTaskSnapshots, ADR-0037),
//   2. adds the sandbox `deploy_targets` entry to project.yaml,
//   3. writes live-lifecycle-config.json with every known fact and explicit placeholders.
// It never creates, records or simulates an approval: requests come from `approvals request` on a
// running runtime and decisions from the PO through `approvals decide`. It only reads approvals
// back (to verify the ids it is given) and holds no credential.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deployPipelineSchema } from "../../src/application/contracts/deploy-delivery.ts";
import type { z } from "zod";
import type { ContentHasher } from "../../src/application/ports/content-hasher.ts";
import type { GithubTaskReader } from "../../src/application/ports/github-task-reader.ts";
import { importTask } from "../../src/application/use-cases/tasks/import-task.ts";
import { storeTaskSnapshots } from "../../src/application/use-cases/tasks/store-task-snapshots.ts";
import {
  createSqliteApprovalStore,
  createSqliteTaskApprovalSubjects,
} from "../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import {
  openReadOnlyStateDatabase,
  openStateDatabase,
  type StateDatabase,
} from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { assertOutsideDirectory, inspectLocalState, prepareLocalState } from "./local-state.ts";
import type { LocalStateInput } from "./local-state.ts";
import { CHECK_NAME } from "./model.ts";
import { runtimeLayout } from "./runtime-layout.ts";

type DeployPipeline = z.infer<typeof deployPipelineSchema>;

export const LIVE_CONFIG_FILE = "live-lifecycle-config.json";
export const PLACEHOLDER_PREFIX = "<PLACEHOLDER";
const placeholder = (what: string) => `${PLACEHOLDER_PREFIX}: ${what}>`;
export const isPlaceholder = (value: unknown): boolean =>
  typeof value === "string"
    ? value.startsWith(PLACEHOLDER_PREFIX)
    : Array.isArray(value) && value.some(isPlaceholder);

export interface LivePrepFlags {
  readonly stateDir: string;
  readonly acceptanceId: string;
  readonly issue: number;
  readonly businessApprovalId?: string;
  readonly deployApprovalId?: string;
  readonly dryRun: boolean;
}

export function parseLivePrepFlags(
  peeled: Readonly<Record<string, string | undefined>>,
  dryRun: boolean,
): LivePrepFlags {
  const stateDir = peeled["--state-dir"];
  if (stateDir === undefined || stateDir === "") throw new Error("--state-dir is required");
  const acceptanceId = peeled["--acceptance-id"];
  if (acceptanceId === undefined || !/^[a-z0-9-]+$/.test(acceptanceId))
    throw new Error("--acceptance-id is required: lowercase letters, digits and -");
  const issue = peeled["--issue"];
  if (issue === undefined || !/^[1-9]\d{0,8}$/.test(issue))
    throw new Error("--issue must be the sandbox task Issue number (a positive integer)");
  const business = peeled["--business-approval-id"];
  const deploy = peeled["--deploy-approval-id"];
  return {
    stateDir,
    acceptanceId,
    issue: Number(issue),
    ...(business === undefined ? {} : { businessApprovalId: business }),
    ...(deploy === undefined ? {} : { deployApprovalId: deploy }),
    dryRun,
  };
}

export interface LiveConfigFacts {
  readonly repository: string;
  readonly acceptanceId: string;
  readonly stateDirectory: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly idea: string;
  readonly issueBody: string;
  readonly baselineHash: string;
  readonly artifactDigest: string;
  readonly pipeline: DeployPipeline;
  readonly businessApprovalId?: string;
  readonly deployApprovalId?: string;
}

/** Operator-owned keys survive a rerun once filled; everything else is refreshed from the facts. */
export function assembleLiveConfig(
  facts: LiveConfigFacts,
  existing: Readonly<Record<string, unknown>>,
): { config: Record<string, unknown>; placeholders: string[] } {
  const keep = (key: string, fallback: unknown): unknown =>
    key in existing && !isPlaceholder(existing[key]) ? existing[key] : fallback;
  const config: Record<string, unknown> = {
    repository: facts.repository,
    acceptanceId: facts.acceptanceId,
    stateDirectory: facts.stateDirectory,
    projectId: facts.projectId,
    taskId: facts.taskId,
    // The harness opens its own task Issue from these; the imported Issue is the business baseline.
    idea: facts.idea.slice(0, 256),
    issueBody: facts.issueBody.trim() === "" ? facts.idea : facts.issueBody.slice(0, 60000),
    baselineHash: facts.baselineHash,
    businessApprovalId:
      facts.businessApprovalId ?? placeholder("run `approvals request` (business), then rerun"),
    head: keep("head", placeholder("pushed sandbox task branch from develop with green checks")),
    evidence: keep("evidence", [placeholder("one artifact reference per top-level AC")]),
    reviewFile: keep("reviewFile", placeholder("absolute path of the independent review JSON")),
    requiredChecks: keep("requiredChecks", [CHECK_NAME]),
    release: facts.acceptanceId,
    artifactDigest: facts.artifactDigest,
    deployApprovalId:
      facts.deployApprovalId ?? placeholder("run `approvals request` (deploy), then rerun"),
    pipeline: facts.pipeline,
    timeoutSeconds: keep("timeoutSeconds", 600),
  };
  const placeholders = Object.keys(config).filter((key) => isPlaceholder(config[key]));
  return { config, placeholders };
}

export function nextSteps(input: {
  readonly stateDir: string;
  readonly taskId: string;
  readonly deployTargetId: string;
  readonly pipelineIssue: number;
  readonly reviewer: string;
}): string[] {
  return [
    "Next steps (this script never creates or decides an approval):",
    `1. Start the runtime with ${input.stateDir} as its project directory (its config and state are there).`,
    "   local-state installed the runtime catalogs; live-prep refreshed the project config hash.",
    `2. omi approvals request ${input.taskId} --kind business    (prints the request id)`,
    `3. omi approvals request ${input.deployTargetId} --kind deploy    (prints the request id)`,
    `4. As ${input.reviewer}, comment the decision on the sandbox pipeline Issue #${String(input.pipelineIssue)}.`,
    "   Then record it through the trusted GitHub pathway:",
    "   omi approvals decide <request-id> --expected-version 0 --decision approved --github-comment <comment-id>",
    "5. Rerun live-prep with --business-approval-id <id> --deploy-approval-id <id> to fill the config.",
  ];
}

export interface LivePrepDeps {
  readonly repository: string;
  readonly projectNumber: number;
  readonly reviewer: string;
  readonly environment: string;
  readonly artifactDigest: string;
  readonly root: string;
  readonly now: () => number;
  readonly newId: () => string;
  /** GraphQL node id of the sandbox Project. */
  readonly projectNodeId: string;
  /** GraphQL node id of the sandbox Issue with this number; refuses anything outside the sandbox. */
  readonly issueNodeId: (issueNumber: number) => Promise<string>;
  readonly reader: GithubTaskReader;
  readonly hasher: ContentHasher;
  readonly pipeline: DeployPipeline;
  readonly migrationsDir?: string;
}

function readOnly<T>(stateDir: string, read: (db: StateDatabase) => T): T {
  const db = openReadOnlyStateDatabase(runtimeLayout(stateDir).database);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Read the id back and require the exact trusted subject; the status is reported, never changed. */
function verifyApproval(
  db: StateDatabase,
  label: string,
  id: string,
  expected: { subjectId: string; subject: unknown },
): string {
  const found = createSqliteApprovalStore(db).get(id);
  if (found === undefined) throw new Error(`refused: ${label} approval ${id} not found`);
  if (
    found.subjectId !== expected.subjectId ||
    JSON.stringify(found.subject) !== JSON.stringify(expected.subject)
  )
    throw new Error(`refused: ${label} approval ${id} does not match the prepared subject`);
  return `${label} approval ${id}: ${found.status}`;
}

export async function runLivePrep(
  deps: LivePrepDeps,
  flags: LivePrepFlags,
): Promise<{ code: number; lines: string[] }> {
  const stateDir = resolve(flags.stateDir);
  assertOutsideDirectory(deps.root, stateDir);
  const local: LocalStateInput = {
    stateDir,
    repository: deps.repository,
    projectNumber: deps.projectNumber,
    reviewer: deps.reviewer,
    now: deps.now,
    newId: deps.newId,
    ...(deps.migrationsDir === undefined ? {} : { migrationsDir: deps.migrationsDir }),
  };
  const { missing } = await inspectLocalState(local);
  if (missing.length > 0)
    throw new Error(
      `refused: local state incomplete (${missing.join(", ")}); run the local-state command first`,
    );

  const [owner = "", name = ""] = deps.repository.split("/");
  const imported = await importTask(
    { reader: deps.reader, hasher: deps.hasher },
    {
      schemaVersion: 1,
      projectId: deps.projectNodeId,
      repository: { owner, name },
      scope: { kind: "list", issueIds: [await deps.issueNodeId(flags.issue)] },
    },
  );
  const snapshot = imported.snapshots.find((s) => s.issue.number === flags.issue);
  if (snapshot === undefined)
    throw new Error(
      `refused: Issue #${String(flags.issue)} is not an importable item of the sandbox Project`,
    );
  const taskId = `task-${String(flags.issue)}`;
  const deployTarget = {
    id: `sandbox-${flags.acceptanceId}`,
    targetEnvironment: deps.environment,
    artifactDigest: deps.artifactDigest,
  };
  const projectId = readOnly(
    stateDir,
    (db) => (db.prepare("SELECT id FROM projects").get() as { id: string }).id,
  );
  const lines = [
    `${flags.dryRun ? "DRY RUN — " : ""}live-prep for ${deps.repository}, acceptance ${flags.acceptanceId}`,
    `task Issue #${String(flags.issue)} → ${taskId}, baseline (snapshot content_hash) ${snapshot.contentHash}`,
    `${String(imported.snapshots.length)} snapshot(s) in scope (the task and its blockers)`,
    `deploy target ${deployTarget.id}: ${deployTarget.targetEnvironment} ${deployTarget.artifactDigest}`,
  ];
  const facts: LiveConfigFacts = {
    repository: deps.repository,
    acceptanceId: flags.acceptanceId,
    stateDirectory: stateDir,
    projectId,
    taskId,
    idea: snapshot.issue.title,
    issueBody: snapshot.issue.body,
    baselineHash: snapshot.contentHash,
    artifactDigest: deps.artifactDigest,
    pipeline: deployPipelineSchema.parse(deps.pipeline),
  };
  const checks: string[] = [];
  const approvalIds: Pick<LiveConfigFacts, "businessApprovalId" | "deployApprovalId"> = {
    ...(flags.businessApprovalId === undefined
      ? {}
      : { businessApprovalId: flags.businessApprovalId }),
    ...(flags.deployApprovalId === undefined ? {} : { deployApprovalId: flags.deployApprovalId }),
  };
  const verify = (db: StateDatabase) => {
    if (flags.businessApprovalId !== undefined)
      checks.push(
        verifyApproval(db, "business", flags.businessApprovalId, {
          subjectId: taskId,
          subject: {
            kind: "business",
            baselineHash: snapshot.contentHash,
            scopeIds: [taskId],
          },
        }),
      );
    if (flags.deployApprovalId !== undefined)
      checks.push(
        verifyApproval(db, "deploy", flags.deployApprovalId, {
          subjectId: deployTarget.id,
          subject: {
            kind: "deploy",
            artifactDigest: deployTarget.artifactDigest,
            environment: deployTarget.targetEnvironment,
          },
        }),
      );
  };
  const configPath = join(stateDir, LIVE_CONFIG_FILE);
  const existing = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : {};

  if (flags.dryRun) {
    readOnly(stateDir, verify);
    const { placeholders } = assembleLiveConfig({ ...facts, ...approvalIds }, existing);
    lines.push(
      ...checks,
      `would store the snapshot(s), update project.yaml and write ${LIVE_CONFIG_FILE}`,
      `placeholders left in the config: ${placeholders.join(", ") || "none"}`,
    );
    return { code: 0, lines };
  }

  const db = openStateDatabase(runtimeLayout(stateDir).database);
  try {
    const stored = storeTaskSnapshots(
      {
        unitOfWork: createSqliteStateUnitOfWork(db),
        approvals: {
          store: createSqliteApprovalStore(db),
          subjects: createSqliteTaskApprovalSubjects(db),
        },
        hasher: deps.hasher,
        now: deps.now,
        nextId: deps.newId,
      },
      { projectId, imported },
    );
    if (!stored.ok) throw new Error(`refused: snapshot store failed: ${stored.reason}`);
    lines.push(`snapshots: ${stored.snapshots.map((s) => `${s.taskId} ${s.outcome}`).join(", ")}`);
    verify(db);
  } finally {
    db.close();
  }
  const { changed } = await prepareLocalState({ ...local, deployTarget });
  lines.push(
    `project.yaml: ${changed.includes("project.yaml") ? "deploy target written" : "unchanged"}`,
  );
  const { config, placeholders } = assembleLiveConfig({ ...facts, ...approvalIds }, existing);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (!existsSync(configPath) || readFileSync(configPath, "utf8") !== text)
    writeFileSync(configPath, text, { mode: 0o600 });
  lines.push(
    ...checks,
    `${LIVE_CONFIG_FILE}: ${configPath}`,
    `placeholders left in the config: ${placeholders.join(", ") || "none"}`,
    ...nextSteps({
      stateDir,
      taskId,
      deployTargetId: deployTarget.id,
      pipelineIssue: deps.pipeline.issueNumber,
      reviewer: deps.reviewer,
    }),
  );
  return { code: 0, lines };
}
