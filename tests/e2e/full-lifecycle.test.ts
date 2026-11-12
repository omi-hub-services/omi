import { createHash } from "node:crypto";
import { dispatchStep } from "../../src/application/use-cases/runs/dispatch-step.ts";
import { recordStepResult } from "../../src/application/use-cases/runs/record-step-result.ts";
import { checkExecutionApprovals } from "../../src/application/services/check-execution-approvals.ts";
import { rig, dispatchInput, skillEvidence } from "../unit/application/use-cases/runs/run-fakes.ts";
import { expect, it } from "vitest";
import { deliverGithubOperation } from "../../src/application/services/deliver-github-operation.ts";
import { preparePr } from "../../src/application/use-cases/delivery/prepare-pr.ts";
import { mergeTaskPr } from "../../src/application/use-cases/delivery/merge-task-pr.ts";
import { prepareRelease } from "../../src/application/use-cases/delivery/prepare-release.ts";
import { checkReleaseMerge } from "../../src/application/use-cases/delivery/check-release-merge.ts";
import { publishRelease } from "../../src/application/use-cases/delivery/publish-release.ts";
import { deployRelease } from "../../src/application/use-cases/delivery/deploy-release.ts";
import { requestApproval } from "../../src/application/use-cases/approvals/request-approval.ts";
import { recordApproval } from "../../src/application/use-cases/approvals/record-approval.ts";
import type { ApprovalRequest, ApprovalSubject } from "../../src/domain/approvals/approval.ts";
import type { ApprovalDecisionSource } from "../../src/application/ports/approval-decision-source.ts";
import type { StateUnitOfWork } from "../../src/application/ports/state-unit-of-work.ts";
import { createGitHubApprovalDecisionSource } from "../../src/infrastructure/github/github-approval-decision-source.ts";
import { createGithubPrDelivery } from "../../src/infrastructure/github/github-pr-delivery.ts";
import { createGithubReleaseReader } from "../../src/infrastructure/github/github-release-reader.ts";
import { createGithubReleaseMergeReader } from "../../src/infrastructure/github/github-release-merge.ts";
import { createGithubDeployReader } from "../../src/infrastructure/github/github-deploy.ts";
import { createGithubRestClient } from "../../src/infrastructure/github/github-rest-client.ts";
import type { PrMapping } from "../../src/application/contracts/pr-delivery.ts";
import { BASE, HEAD, ISSUE_BODY, REPO, request, sandbox } from "./merge-task-pr-sandbox.ts";

it("retains evidence from the idea through two separate approval gates to deployment", async () => {
  const s = sandbox();
  const evidence: string[] = [];
  const client = createGithubRestClient({
    transport: s.github,
    now: s.deps.now,
    random: () => 0,
    sleep: () => Promise.resolve(),
    policy: { maxTries: 1 },
  });
  // Keep the sandbox's independent review and task store; create the Issue/PR through use cases.
  s.github.issues.splice(0);
  s.github.pulls.splice(0);
  const approvals = new Map<string, ApprovalRequest>();
  const subjects = new Map<string, ApprovalSubject>();
  let sequence = 0;
  const unitOfWork: StateUnitOfWork = {
    commit(change) {
      if (change.target.kind === "approval_request" || change.target.kind === "approval_decision") {
        approvals.set(change.target.request.id, change.target.request);
        return { ok: true, newVersion: change.target.request.version, eventSequence: ++sequence };
      }
      return s.deps.unitOfWork.commit(change);
    },
  };
  const approvalDeps = {
    unitOfWork,
    now: s.deps.now,
    nextId: () => `approval-${String(++sequence)}`,
    subjects: { read: (id: string) => subjects.get(id) },
    store: { get: (id: string) => approvals.get(id) },
    allowedGitHubActors: ["po"],
  };
  async function approve(
    subjectId: string,
    subject: ApprovalSubject,
    nativeSource?: ApprovalDecisionSource,
  ) {
    subjects.set(subjectId, subject);
    const pending = requestApproval(approvalDeps, {
      schemaVersion: 1,
      subjectId,
      kind: subject.kind,
    });
    if (!pending.ok) throw new Error(pending.reason);
    const comment = {
      user: { login: "po", type: "User" },
      created_at: "2026-11-11T08:00:00Z",
      updated_at: "2026-11-11T08:00:00Z",
      body: JSON.stringify({
        schemaVersion: 1,
        approvalId: pending.request.id,
        subjectHash: pending.request.subjectHash,
        version: pending.request.version,
        decision: "approved",
      }),
    };
    const source = createGitHubApprovalDecisionSource({
      repository: REPO,
      confirmCli: () => Promise.resolve(undefined),
      readComment: () => Promise.resolve(comment),
    });
    const result = await recordApproval(
      { ...approvalDeps, source: nativeSource ?? source },
      {
        schemaVersion: 1,
        approvalId: pending.request.id,
        expectedVersion: pending.request.version,
        decision: "approved",
        pathway: "github",
        evidenceRef: "91",
      },
    );
    expect(result.ok).toBe(true);
    return pending.request.id;
  }
  const idea = "Deliver independently reviewed changes with required checks";
  const businessApproval = await approve("idea-baseline", {
    kind: "business",
    baselineHash: "f".repeat(64),
    scopeIds: ["task-27"],
  });
  expect(
    checkExecutionApprovals(
      approvalDeps,
      [{ approvalId: businessApproval, subjectId: "idea-baseline", kind: "business" }],
      ["po"],
      "omi-bot",
    ),
  ).toEqual({ allowed: true });
  evidence.push("idea");
  const issue = await deliverGithubOperation(s.deps, "lifecycle:idea:task", {
    type: "issue.create",
    repo: REPO,
    title: idea,
    body: ISSUE_BODY,
  });
  expect(issue.kind).toBe("succeeded");
  const taskIssue = s.github.issues[0];
  if (taskIssue === undefined) throw new Error("Issue not created");
  expect(taskIssue.body).toContain(ISSUE_BODY);
  evidence.push("issue");
  const workers = rig();
  const catalog = workers.deps.catalog;
  const developer = catalog.roles[0];
  if (developer === undefined) throw new Error("developer role missing");
  const workerDeps = {
    ...workers.deps,
    catalog: {
      ...catalog,
      roles: [
        ...catalog.roles,
        { ...developer, definition: { ...developer.definition, id: "reviewer" } },
      ],
    },
  };
  const reports: string[] = [];
  for (const [stepId, role, runId] of [
    ["implement", "developer", "run-impl"],
    ["review", "reviewer", "run-review"],
  ]) {
    if (stepId === undefined || role === undefined || runId === undefined)
      throw new Error("worker fixture missing");
    const rowId = `step-${stepId}`;
    workers.steps.rows.set(rowId, { id: rowId, runId, stepId, status: "ready", version: 1 });
    const dispatched = await dispatchStep(
      workerDeps,
      dispatchInput({
        stepRunId: rowId,
        role,
        taskId: request.taskId,
        slug: "omi-023-merge-gates",
      }),
    );
    if (!dispatched.ok) throw new Error(dispatched.reason);
    expect(dispatched.contextPacket.taskSnapshot).toBeDefined();
    const body =
      stepId === "review"
        ? "**VERDICT:** PASS\nAC-1: met — independent reviewer\nAC-2: met — pinned CI evidence"
        : "Regression reproduced; implementation passes required checks";
    const report = workers.artifacts.publish(`${dispatched.attempt.artifactRoot}/report.md`, body);
    const skills = skillEvidence(dispatched.attempt, (path, content) =>
      workers.artifacts.publish(path, content),
    );
    const result = recordStepResult(workerDeps, {
      attemptId: dispatched.attempt.id,
      execution: await workers.executor.collectResult(dispatched.handle),
      result: {
        schemaVersion: 1,
        runId,
        stepId,
        attemptId: dispatched.attempt.id,
        status: "succeeded",
        summary: body,
        artifacts: [report, ...skills.artifacts],
        revision: { headSha: HEAD, baseSha: BASE },
        checks: [{ id: "unit-tests", evidenceRef: report.path }],
        skillsApplied: skills.skillsApplied,
        findings: [],
      },
    });
    expect(result).toMatchObject({ ok: true, stepStatus: "succeeded" });
    reports.push(report.path);
    if (stepId === "review")
      s.reviews.set(HEAD, {
        reviewerRunId: runId,
        reviewerAgentId: "codex-reviewer",
        headSha: HEAD,
        baseSha: BASE,
        verdict: "pass",
        body,
      });
  }
  expect(workers.executor.started).toHaveLength(2);
  s.github.branches.set(`${REPO}:task/omi-023-merge-gates`, HEAD);
  let mapping: PrMapping | undefined;
  const mappings = {
    get: () => mapping,
    save: (value: PrMapping) => {
      mapping = value;
    },
  };
  const prepared = await preparePr(
    { ...s.deps, reader: createGithubPrDelivery(client), mappings },
    {
      projectId: request.projectId,
      taskId: request.taskId,
      repository: REPO,
      issueNumber: taskIssue.number,
      head: "task/omi-023-merge-gates",
      title: idea,
      evidence: reports,
    },
  );
  if (prepared.status !== "verified") throw new Error("PR not prepared");
  const taskPull = s.github.pulls.find((p) => p.number === prepared.mapping.prNumber);
  if (taskPull === undefined) throw new Error("task pull missing");
  taskPull.headSha = HEAD;
  expect(
    await mergeTaskPr(
      { ...s.deps, mappings },
      { ...request, issueNumber: taskIssue.number, prNumber: taskPull.number },
    ),
  ).toMatchObject({ status: "done", ticked: 2 });
  expect(taskIssue.state).toBe("closed");
  expect(s.task.completions).toHaveLength(1);
  const develop = s.github.branches.get(`${REPO}:develop`);
  expect(develop).toBe(taskPull.mergeCommitSha);
  evidence.push("develop");
  const releases = createGithubReleaseReader(client);
  const release = await prepareRelease(
    { ...s.deps, releases, pulls: createGithubPrDelivery(client) },
    { repository: REPO, release: "lifecycle-r1" },
  );
  if (release.status !== "verified") throw new Error("release not prepared");
  expect(release.tasks).toEqual([expect.objectContaining({ issueNumber: taskIssue.number })]);
  const releasePull = s.github.pulls.find((p) => p.number === release.prNumber);
  if (releasePull === undefined || develop === undefined) throw new Error("release pull missing");
  releasePull.headSha = develop;
  s.github.branches.set(`${REPO}:main`, BASE);
  s.github.rules.set(`${REPO}:main`, [
    { type: "pull_request", parameters: { required_approving_review_count: 1 } },
  ]);
  s.github.protections.set(`${REPO}:main`, { enforce_admins: { enabled: true } });
  s.github.statuses.push({ repo: REPO, sha: develop, context: "ci", state: "success" });
  const releaseReader = createGithubReleaseMergeReader(client);
  const releaseRequest = {
    repository: REPO,
    prNumber: release.prNumber,
    expectedHeadSha: develop,
    poActors: ["po"],
    requiredChecks: ["ci"],
  };
  expect((await checkReleaseMerge(releaseReader, releaseRequest)).allowed).toBe(false);
  const digest = `sha256:${"a".repeat(64)}`;
  const deployApproval = await approve("artifact", {
    kind: "deploy",
    artifactDigest: digest,
    environment: "sandbox",
  });
  // A digest/environment decision cannot supply a native release PR review.
  expect((await checkReleaseMerge(releaseReader, releaseRequest)).allowed).toBe(false);
  s.github.reviews.push({
    repo: REPO,
    pullNumber: release.prNumber,
    login: "po",
    type: "User",
    state: "APPROVED",
    commitId: develop,
  });
  expect(await checkReleaseMerge(releaseReader, releaseRequest)).toEqual({ allowed: true });
  const releaseApproval = await approve(
    "release-head",
    { kind: "release", pullRequestId: String(release.prNumber), headSha: develop },
    {
      async verify(pending) {
        const reviews = await releaseReader.nativeReviews(REPO, release.prNumber);
        const native = reviews.find(
          (r) => r.actor === "po" && r.state === "APPROVED" && r.commitSha === develop,
        );
        if (native === undefined) return undefined;
        return {
          approvalId: pending.id,
          subjectHash: pending.subjectHash,
          version: pending.version,
          decision: "approved",
          actor: native.actor,
          source: "github-actor",
          evidenceRef: `native-review:${String(release.prNumber)}:${develop}`,
        };
      },
    },
  );
  expect(releaseApproval).not.toBe(deployApproval);

  expect(
    (await checkReleaseMerge(releaseReader, { ...releaseRequest, expectedHeadSha: HEAD })).allowed,
  ).toBe(false);
  // The release merger is external to the product; the native server still checks the pinned SHA.
  const merged = await client.request({
    method: "PUT",
    path: `repos/${REPO}/pulls/${String(release.prNumber)}/merge`,
    body: { sha: develop, merge_method: "merge" },
  });
  expect(merged).toBeDefined();
  const published = await publishRelease(
    { ...s.deps, releases, pulls: s.deps.reader },
    {
      repository: REPO,
      release: "lifecycle-r1",
      prNumber: release.prNumber,
    },
  );
  expect(published).toMatchObject({ status: "published", commitSha: releasePull.mergeCommitSha });
  expect(s.github.tags.get(`${REPO}:lifecycle-r1`)).toBe(releasePull.mergeCommitSha);
  expect(s.github.releases[0]?.body).toContain(`Issue #${String(taskIssue.number)}`);
  evidence.push("release");
  s.github.tags.set(`${REPO}:pipeline-1`, BASE);
  const deployDeps = {
    ...s.deps,
    unitOfWork,
    session: { renew: () => true, record: () => undefined },
    hasher: { sha256: (text: string) => createHash("sha256").update(text).digest("hex") },
    pipeline: {
      workflow: "deploy.yml",
      ref: "pipeline-1",
      workflowSha: BASE,
      issueNumber: release.releaseIssueNumber,
      allowedActors: ["po"],
      authorActor: "omi-bot",
    },
    approvals: approvalDeps.store,
    deployments: createGithubDeployReader(client),
    maxPolls: 1,
    pollIntervalMs: 0,
    sleep: () => Promise.resolve(),
  };
  const deployRequest = {
    repository: REPO,
    environment: "sandbox",
    artifactDigest: digest,
    approvalId: deployApproval,
  };
  expect(
    await deployRelease(deployDeps, { ...deployRequest, approvalId: releaseApproval }),
  ).toEqual({ status: "refused", reason: "STALE_REVISION" });
  for (const changed of [{ artifactDigest: `sha256:${"b".repeat(64)}` }, { environment: "other" }])
    expect(await deployRelease(deployDeps, { ...deployRequest, ...changed })).toEqual({
      status: "refused",
      reason: "STALE_REVISION",
    });
  s.github.deployNativeApproved = false;
  s.github.deployStatus = "waiting";
  s.github.deployConclusion = null;
  expect(await deployRelease(deployDeps, deployRequest)).toMatchObject({ status: "pending" });
  s.github.deployNativeApproved = true;
  s.github.deployConclusion = "success";
  const run = s.github.deployRuns[0];
  if (run === undefined) throw new Error("deployment not dispatched");
  run["status"] = "completed";
  run["conclusion"] = "success";
  expect(await deployRelease(deployDeps, deployRequest)).toMatchObject({
    status: "verified",
    evidence: {
      runId: run["id"],
      nativeApproved: true,
      artifactDigest: digest,
      deploymentStatus: "success",
    },
  });
  expect(
    s.github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/dispatches")),
  ).toHaveLength(1);
  expect(
    s.github.requests.some(
      (r) => r.method !== "GET" && /reviews|approvals|pending_deployments/.test(r.path),
    ),
  ).toBe(false);
  evidence.push("deploy");
  expect(evidence).toEqual(["idea", "issue", "develop", "release", "deploy"]);
});
