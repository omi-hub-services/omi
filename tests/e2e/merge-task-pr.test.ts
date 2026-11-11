import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MergeEvidence } from "../../src/application/contracts/merge-delivery.ts";
import type { TaskCompletion } from "../../src/application/ports/merge-delivery.ts";
import { mergeTaskPr } from "../../src/application/use-cases/delivery/merge-task-pr.ts";
import type { MergeTaskPrDeps } from "../../src/application/use-cases/delivery/merge-task-pr.ts";
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

const REPO = "acme/app";
const ISSUE = 27;
const PR = 128;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PUSHED = "c".repeat(40);
const NOW = Date.parse("2026-11-11T08:00:00.000Z");

const ISSUE_BODY = [
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

const request = {
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
function sandbox() {
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
    body: `Issue: #${String(ISSUE)}\nTask: task-27\n\n## Acceptance criteria and evidence`,
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

describe("merge a task PR, then tick, close and record Done", () => {
  it("merges the reviewed head, confirms it on develop, ticks only the AC section and closes", async () => {
    const s = sandbox();
    const result = await mergeTaskPr(s.deps, request);

    const mergeSha = s.pull()?.mergeCommitSha;
    expect(result).toEqual({ status: "done", mergeCommitSha: mergeSha, ticked: 2 });
    expect(s.github.branches.get(`${REPO}:develop`)).toBe(mergeSha);
    expect(s.github.commits.get(mergeSha ?? "")?.parents).toEqual([BASE, HEAD]);
    // Only the two criteria changed; the nested note and checkboxes in other sections did not.
    expect(s.issue()?.body).toBe(
      ISSUE_BODY.replace("- [ ] Independent", "- [x] Independent").replace(
        "- [ ] Head/base",
        "- [x] Head/base",
      ),
    );
    expect(s.issue()?.state).toBe("closed");
    expect(s.task.status).toBe("done");
    expect(s.task.completions).toMatchObject([{ mergeCommitSha: mergeSha, toStatus: "done" }]);
    // No review or approval was ever written to GitHub.
    expect(s.github.requests.some((r) => r.path.includes("/reviews") && r.method !== "GET")).toBe(
      false,
    );

    // Calling again changes nothing on GitHub.
    const before = s.github.requests.filter((r) => r.method !== "GET").length;
    expect(await mergeTaskPr(s.deps, request)).toMatchObject({ status: "done", ticked: 0 });
    expect(s.github.requests.filter((r) => r.method !== "GET").length).toBe(before);
    expect(s.writes("PUT", "/merge")).toBe(1);
  });

  it("refuses a PR whose head is not the reviewed SHA, and merges nothing", async () => {
    const s = sandbox();
    const pull = s.pull();
    if (pull !== undefined) pull.headSha = PUSHED;
    const result = await mergeTaskPr(s.deps, request);
    expect(result).toMatchObject({ status: "refused", step: "merge" });
    expect(result.status === "refused" ? result.reasons : []).toEqual(
      expect.arrayContaining(["HEAD_MOVED", "STALE_REVISION", "REQUIRED_CHECK_MISSING"]),
    );
    expect(s.writes("PUT", "/merge")).toBe(0);
    expect(s.issue()?.state ?? "open").toBe("open");
    expect(s.task.status).toBe("in_progress");
  });

  it("refuses a failing required check on the exact head", async () => {
    const s = sandbox();
    s.github.checkRuns.push({
      repo: REPO,
      id: 2,
      name: "ci",
      headSha: HEAD,
      status: "completed",
      conclusion: "failure",
    });
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["CHECKS_FAILED"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
  });

  it("refuses a review without a line for every criterion", async () => {
    const s = sandbox();
    const review = s.reviews.get(HEAD);
    if (review !== undefined) {
      s.reviews.set(HEAD, { ...review, body: "**VERDICT:** PASS\nAC-1: met — reviewer differs" });
    }
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["AC_LINE_MISSING"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
    expect(s.issue()?.body).toBe(ISSUE_BODY);
  });

  it("refuses a review with a `not met` line", async () => {
    const s = sandbox();
    const review = s.reviews.get(HEAD);
    if (review !== undefined) {
      s.reviews.set(HEAD, {
        ...review,
        body: "AC-1: met — reviewer differs\nAC-2: not met — no failing-check test",
      });
    }
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["AC_NOT_MET"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
  });

  it("never merges or closes twice when responses are lost and the runtime restarts", async () => {
    const s = sandbox();
    // GitHub merges, then the response is lost.
    s.github.inject({
      method: "PUT",
      pathIncludes: "/merge",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    expect(await mergeTaskPr(s.deps, request)).toMatchObject({
      status: "pending",
      step: "merge",
      state: "outcome_unknown",
    });
    expect(s.pull()?.merged).toBe(true);
    expect(s.task.status).toBe("in_progress");

    // After a restart the merge is found by read-back; then the close response is lost too.
    s.github.inject({
      method: "PATCH",
      pathIncludes: `/issues/${String(ISSUE)}`,
      times: 2,
      effect: { type: "apply_then_fail", failure: "connection" },
    });
    let deps = s.restart();
    const second = await mergeTaskPr(deps, request);
    expect(second).toMatchObject({ status: "pending", step: "tick", state: "outcome_unknown" });

    deps = s.restart();
    expect(await mergeTaskPr(deps, request)).toMatchObject({
      status: "pending",
      step: "close",
      state: "outcome_unknown",
    });

    deps = s.restart();
    expect(await mergeTaskPr(deps, request)).toMatchObject({ status: "done" });
    expect(s.writes("PUT", "/merge")).toBe(1);
    expect(s.writes("PATCH", `/issues/${String(ISSUE)}`)).toBe(2);
    expect(s.issue()?.state).toBe("closed");
    expect(s.task.status).toBe("done");
    expect(deps.outbox.listUnresolved()).toHaveLength(0);
  });

  it("refuses to tick or close from a merged-head review that marks a criterion not met", async () => {
    const s = sandbox();
    // Someone merged the reviewed head outside the runtime; the review on it is not a full PASS.
    const pull = s.pull();
    const mergeSha = "e".repeat(40);
    if (pull !== undefined) {
      Object.assign(pull, { merged: true, mergeCommitSha: mergeSha, state: "closed" });
    }
    s.github.commits.set(mergeSha, { repo: REPO, parents: [BASE, HEAD] });
    s.github.branches.set(`${REPO}:develop`, mergeSha);
    const review = s.reviews.get(HEAD);
    if (review !== undefined) {
      s.reviews.set(HEAD, { ...review, body: "AC-1: met — a\nAC-2: not met — b" });
    }
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "tick",
      reasons: ["AC_NOT_MET"],
    });
    expect(s.issue()?.body).toBe(ISSUE_BODY);
    expect(s.issue()?.state ?? "open").toBe("open");
    expect(s.task.status).toBe("in_progress");
    expect(s.writes("PATCH", "/issues")).toBe(0);
  });

  it("does not tick or close the Issue for a task the task machine cannot move to Done", async () => {
    const s = sandbox();
    s.task.status = "ready";
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "done",
      reasons: ["TRANSITION_NOT_ALLOWED"],
    });
    expect(s.pull()?.merged).toBe(true);
    expect(s.issue()?.body).toBe(ISSUE_BODY);
    expect(s.issue()?.state ?? "open").toBe("open");
  });

  it("counts only a real native approval on the head when the ruleset requires one", async () => {
    const s = sandbox();
    s.github.rules.get(`${REPO}:develop`)?.push({
      type: "pull_request",
      parameters: { required_approving_review_count: 1 },
    });
    // The runtime's own account and an approval of an older head do not count.
    s.github.reviews.push(
      {
        repo: REPO,
        pullNumber: PR,
        login: "omi-bot",
        type: "User",
        state: "APPROVED",
        commitId: HEAD,
      },
      { repo: REPO, pullNumber: PR, login: "po", type: "User", state: "APPROVED", commitId: BASE },
    );
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["NATIVE_APPROVAL_MISSING"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);

    s.github.reviews.push({
      repo: REPO,
      pullNumber: PR,
      login: "po",
      type: "User",
      state: "APPROVED",
      commitId: HEAD,
    });
    expect(await mergeTaskPr(s.deps, request)).toMatchObject({ status: "done" });
  });

  it("refuses while another runtime holds the merge lock for develop", async () => {
    const s = sandbox();
    s.deps.leases.acquire({
      resourceKey: `merge-queue:${REPO}:develop`,
      owner: "runtime-2",
      now: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 30_000).toISOString(),
    });
    expect(await mergeTaskPr(s.deps, request)).toEqual({
      status: "refused",
      step: "merge",
      reasons: ["MERGE_LOCK_NOT_HELD"],
    });
    expect(s.writes("PUT", "/merge")).toBe(0);
  });
});
