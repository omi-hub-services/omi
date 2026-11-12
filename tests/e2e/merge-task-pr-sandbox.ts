import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import type { MergeEvidence } from "../../src/application/contracts/merge-delivery.ts";
import type { TaskCompletion } from "../../src/application/ports/merge-delivery.ts";
import type { MergeTaskPrDeps } from "../../src/application/use-cases/delivery/merge-task-pr.ts";
import { operationMarker } from "../../src/domain/delivery/operation-marker.ts";
import type { TaskStatus } from "../../src/domain/tasks/task-status.ts";
import { createLocalArtifactStore } from "../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createGithubMergeDelivery } from "../../src/infrastructure/github/github-merge-delivery.ts";
import { createGithubRemote } from "../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../src/infrastructure/github/github-rest-client.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteLeaseStore } from "../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteOutboxStore } from "../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createSqlitePrMappingStore } from "../../src/infrastructure/persistence/sqlite/sqlite-pr-mapping-store.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { FakeGithub } from "../contract/github/fake-github.ts";

export const REPO = "acme/app";
const ISSUE = 27;
const PR = 128;
export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const PUSHED = "c".repeat(40);
const NOW = Date.parse("2026-11-11T08:00:00.000Z");
/** The key `preparePr` created the PR under; its marker is on the PR body. */
const PR_CREATION_KEY = `create-pr:${REPO}:task-27:task/omi-023-merge-gates:develop`;

export const ISSUE_BODY = [
  "## Goal",
  "- [ ] outside the AC section stays as it is",
  "",
  "## Acceptance criteria",
  "- [ ] Independent reviewer.",
  "- [ ] Head/base validation; required checks.",
  "  - [ ] nested note, not a criterion",
  "",
  "## Notes",
  "- [ ] not a criterion either",
].join("\n");
const PASS = "**VERDICT:** PASS\n\nAC-1: met — reviewer run differs\nAC-2: met — e2e test";

export const request = {
  projectId: "project-1",
  taskId: "task-27",
  repository: REPO,
  issueNumber: ISSUE,
  prNumber: PR,
  reviewedHeadSha: HEAD,
  requiredChecks: ["ci"],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A delivered task PR into develop with a PASS review on its head and green CI. */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "omi-merge-"));
  dirs.push(dir);
  mkdirSync(join(dir, "artifacts"));
  let db: StateDatabase = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../migrations")));
  db.prepare(
    "INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    "project-1",
    REPO,
    "a".repeat(64),
    new Date(NOW).toISOString(),
    new Date(NOW).toISOString(),
  );

  const github = new FakeGithub({ now: () => NOW });
  github.issues.push({
    number: ISSUE,
    repo: REPO,
    title: "Review/check gates & merge",
    body: ISSUE_BODY,
    createdAt: new Date(NOW).toISOString(),
  });
  github.pulls.push({
    number: PR,
    repo: REPO,
    title: "Merge gates",
    body: `Issue: #${String(ISSUE)}\nTask: task-27\n\n## Acceptance criteria and evidence\n\n${operationMarker(PR_CREATION_KEY)}`,
    createdAt: new Date(NOW).toISOString(),
    head: "task/omi-023-merge-gates",
    base: "develop",
    headSha: HEAD,
    author: "omi-bot",
  });
  github.branches.set(`${REPO}:develop`, BASE);
  github.commits.set(BASE, { repo: REPO, parents: [] });
  github.commits.set(HEAD, { repo: REPO, parents: [BASE] });
  github.rules.set(`${REPO}:develop`, [
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } },
  ]);
  github.checkRuns.push({
    repo: REPO,
    id: 1,
    name: "ci",
    headSha: HEAD,
    status: "completed",
    conclusion: "success",
  });

  const reviews = new Map<string, MergeEvidence["review"]>([
    [
      HEAD,
      {
        reviewerRunId: "run-review",
        reviewerAgentId: "codex-reviewer",
        headSha: HEAD,
        baseSha: BASE,
        verdict: "pass",
        body: PASS,
      },
    ],
  ]);
  const task = { status: "in_progress" as TaskStatus, completions: [] as TaskCompletion[] };
  const client = createGithubRestClient({
    transport: github,
    now: () => NOW,
    random: () => 0,
    sleep: () => Promise.resolve(),
  });
  let id = 0;
  const wire = (): MergeTaskPrDeps => ({
    now: () => NOW,
    newId: () => `merge-${String(++id)}`,
    newEventId: () => `event-${String(++id)}`,
    reconcileGraceMs: 120_000,
    batchSize: 10,
    jitter: () => 0,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 },
    artifacts: createLocalArtifactStore(join(dir, "artifacts"), db),
    unitOfWork: createSqliteStateUnitOfWork(db),
    outbox: createSqliteOutboxStore(db),
    mappings: createSqlitePrMappingStore(db),
    leases: createSqliteLeaseStore(db),
    github: createGithubRemote(client),
    reader: createGithubMergeDelivery(client),
    evidence: {
      read: (_project, _task, headSha) => {
        const review = reviews.get(headSha);
        return {
          ...(review === undefined ? {} : { review }),
          authorRunIds: ["run-impl"],
          authorAgentIds: ["claude-implementer"],
          unresolvedMandatoryFindings: 0,
          workflowGatesPassed: true,
        };
      },
    },
    tasks: {
      status: () => task.status,
      complete: (change) => {
        if (change.expectedStatus !== task.status) return { ok: false, reason: "STALE_STATUS" };
        task.status = change.toStatus;
        task.completions.push(change);
        return { ok: true };
      },
    },
    mergeLockOwner: "runtime-1",
    mergeLockTtlMs: 60_000,
  });
  const deps = wire();
  deps.mappings.save({
    projectId: "project-1",
    taskId: "task-27",
    repository: REPO,
    issueNumber: ISSUE,
    prNumber: PR,
  });
  const writes = (method: string, pathIncludes: string) =>
    github.requests.filter((r) => r.method === method && r.path.includes(pathIncludes)).length;
  return {
    github,
    reviews,
    task,
    deps,
    writes,
    /** Closes and reopens the state database, like a runtime restart after a crash. */
    restart(): MergeTaskPrDeps {
      db.close();
      db = openStateDatabase(join(dir, "state.db"));
      return wire();
    },
    issue: () => github.issues.find((i) => i.number === ISSUE),
    pull: () => github.pulls.find((p) => p.number === PR),
  };
}
