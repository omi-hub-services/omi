import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deployRelease } from "../../../src/application/use-cases/delivery/deploy-release.ts";
import { createGithubDeployReader } from "../../../src/infrastructure/github/github-deploy.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import type { ApprovalRequest } from "../../../src/domain/approvals/approval.ts";
import { approvalSubjectHash } from "../../../src/domain/approvals/approval.ts";
import { preparationHarness } from "../../unit/application/use-cases/delivery/prepare-pr-fakes.ts";
import { FakeGithub } from "./fake-github.ts";

const digest = `sha256:${"a".repeat(64)}`;
const request = {
  repository: "acme/sandbox",
  environment: "sandbox",
  artifactDigest: digest,
  approvalId: "deploy-1",
};
const pipeline = {
  workflow: "deploy.yml",
  ref: "deploy-pipeline-1",
  workflowSha: "b".repeat(40),
  issueNumber: 48,
  allowedActors: ["po"],
  authorActor: "omi-bot",
};
function setup() {
  const h = preparationHarness();
  const fake = new FakeGithub();
  fake.tags.set("acme/sandbox:deploy-pipeline-1", "b".repeat(40));
  const client = createGithubRestClient({
    transport: fake,
    now: () => h.clock.ms,
    random: () => 0,
    sleep: () => Promise.resolve(),
    policy: { maxTries: 1 },
  });
  const subject = { kind: "deploy" as const, artifactDigest: digest, environment: "sandbox" };
  let approval: ApprovalRequest | undefined = {
    id: "deploy-1",
    subjectId: "deploy-1",
    subjectHash: approvalSubjectHash(subject),
    subject,
    status: "approved",
    version: 1,
    requestedAt: h.clock.ms,
    decision: {
      id: "deploy-1",
      subject,
      decision: "approved",
      actor: "po",
      source: "github-actor",
      decidedAt: h.clock.ms,
    },
  };
  const events: string[] = [];
  const deps = {
    ...h.deps,
    session: {
      renew: () => true,
      record: (_kind: string, payload: Readonly<Record<string, unknown>>) => {
        events.push(JSON.stringify(payload));
      },
    },
    hasher: { sha256: (text: string) => createHash("sha256").update(text).digest("hex") },
    pipeline,
    approvals: { get: (id: string) => (approval?.id === id ? approval : undefined) },
    deployments: createGithubDeployReader(client),
    github: createGithubRemote(client),
    sleep: () => Promise.resolve(),
    maxPolls: 2,
    pollIntervalMs: 1,
    unitOfWork: {
      commit: (change: Parameters<typeof h.deps.unitOfWork.commit>[0]) => {
        events.push(change.event.payload);
        return change.outbox === undefined
          ? { ok: true as const, newVersion: 0, eventSequence: 1 }
          : h.deps.unitOfWork.commit(change);
      },
    },
  };
  return {
    ...h,
    fake,
    deps,
    events,
    setApproval: (value: ApprovalRequest | undefined) => {
      approval = value;
    },
    getApproval: () => approval,
  };
}

function approveDigest(h: ReturnType<typeof setup>, artifactDigest: string, approvalId: string) {
  const previous = h.getApproval();
  if (previous?.decision === undefined) throw new Error("fixture approval missing");
  const subject = { kind: "deploy" as const, artifactDigest, environment: "sandbox" };
  h.setApproval({
    ...previous,
    id: approvalId,
    subject,
    subjectHash: approvalSubjectHash(subject),
    decision: { ...previous.decision, id: approvalId, subject },
  });
  return { ...request, artifactDigest, approvalId };
}

function expectVerified(result: Awaited<ReturnType<typeof deployRelease>>) {
  expect(result.status).toBe("verified");
  if (result.status !== "verified") throw new Error("verification missing");
  return result.evidence;
}

describe("deploy release through fake GitHub", () => {
  it("dispatches the immutable digest and records successful run and deployment evidence", async () => {
    const h = setup();
    expect(await deployRelease(h.deps, request)).toMatchObject({
      status: "verified",
      evidence: { conclusion: "success", deploymentStatus: "success", artifactDigest: digest },
    });
    expect(h.events.some((e) => e.includes('"deploymentStatus":"success"'))).toBe(true);
  });
  it("reconciles a lost dispatch response after a restart without dispatching twice", async () => {
    const h = setup();
    h.fake.inject({
      method: "POST",
      pathIncludes: "/dispatches",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    expect(await deployRelease(h.deps, request)).toMatchObject({ status: "pending" });
    const restarted = {
      ...h.deps,
      deployments: createGithubDeployReader(
        createGithubRestClient({
          transport: h.fake,
          now: () => h.clock.ms,
          random: () => 0,
          sleep: () => Promise.resolve(),
        }),
      ),
      github: h.deps.github,
    };
    expect(await deployRelease(restarted, request)).toMatchObject({ status: "verified" });
    expect(await deployRelease(restarted, request)).toMatchObject({ status: "verified" });
    expect(
      h.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
    ).toHaveLength(1);
  });
  it.each(["failure", "cancelled", "timed_out"])(
    "reports a %s run to the PO using the existing comment outbox",
    async (conclusion) => {
      const h = setup();
      h.fake.deployConclusion = conclusion;
      expect(await deployRelease(h.deps, request)).toMatchObject({
        status: "failed",
        evidence: { conclusion },
      });
      await deployRelease(h.deps, request);
      expect(h.fake.comments).toHaveLength(1);
      expect(h.fake.comments[0]?.body).toContain("@po");
      expect(h.fake.comments[0]?.body).toContain(digest);
      expect(
        h.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
      ).toHaveLength(1);
    },
  );
  it("refuses rollback without an authenticated approved runbook", async () => {
    const h = setup();
    expect(
      await deployRelease(h.deps, {
        ...request,
        rollback: { runbookRef: "rollback-sandbox-r1", approvalId: "missing" },
      }),
    ).toMatchObject({ status: "refused", reason: "RUNBOOK_NOT_APPROVED" });
    expect(h.fake.requests).toHaveLength(0);
  });
  it("refuses an inactive deploy approval", async () => {
    const h = setup();
    const approval = h.getApproval();
    if (approval === undefined) throw new Error("fixture missing");
    h.setApproval({ ...approval, status: "invalidated" });
    expect(await deployRelease(h.deps, request)).toMatchObject({
      status: "refused",
      reason: "APPROVAL_NOT_ACTIVE",
    });
    expect(h.fake.requests).toHaveLength(0);
  });
  it("refuses a missing approval", async () => {
    const h = setup();
    h.setApproval(undefined);
    expect(await deployRelease(h.deps, request)).toMatchObject({
      status: "refused",
      reason: "NO_APPROVAL",
    });
    expect(h.fake.requests).toHaveLength(0);
  });
  it("uses a bounded stable tuple key for long repositories and environments", async () => {
    const h = setup();
    const repository = `${"a".repeat(80)}/${"b".repeat(80)}`;
    h.fake.tags.set(`${repository}:deploy-pipeline-1`, "b".repeat(40));
    expect(await deployRelease(h.deps, { ...request, repository })).toMatchObject({
      status: "verified",
    });
  });
  it("refuses a moved workflow tag before dispatch", async () => {
    const h = setup();
    h.fake.tags.set("acme/sandbox:deploy-pipeline-1", "c".repeat(40));
    expect(await deployRelease(h.deps, request)).toMatchObject({
      status: "failed",
      reason: "WORKFLOW_REVISION_MISMATCH",
    });
    expect(h.fake.requests.some((r) => r.path.includes("/dispatches"))).toBe(false);
  });
  it("holds an unconfirmed dispatch forever even beyond the reconcile grace period", async () => {
    const h = setup();
    h.fake.inject({
      method: "POST",
      pathIncludes: "/dispatches",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    await deployRelease(h.deps, request);
    const hidden = h.fake.deployRuns.splice(0);
    h.clock.ms += 1000000;
    expect(await deployRelease(h.deps, request)).toMatchObject({ status: "pending" });
    h.fake.deployRuns.push(...hidden);
    expect(await deployRelease(h.deps, request)).toMatchObject({ status: "verified" });
    expect(
      h.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
    ).toHaveLength(1);
  });
  it("refuses an unprotected environment", async () => {
    const h = setup();
    h.fake.deployProtected = false;
    expect(await deployRelease(h.deps, request)).toMatchObject({
      status: "failed",
      reason: "ENVIRONMENT_NOT_PROTECTED",
    });
    expect(h.fake.requests.some((r) => r.path.includes("/dispatches"))).toBe(false);
  });
  it("never verifies a deployment of a different digest", async () => {
    const h = setup();
    h.fake.deployDigestOverride = `sha256:${"c".repeat(64)}`;
    expect(await deployRelease(h.deps, request)).toMatchObject({
      status: "failed",
      reason: "DEPLOY_DIGEST_MISMATCH",
    });
    expect(h.fake.comments).toHaveLength(1);
  });
  it("keeps polling pending without cancelling or redispatching", async () => {
    const h = setup();
    h.fake.deployStatus = "waiting";
    h.fake.deployConclusion = null;
    expect(await deployRelease(h.deps, request)).toMatchObject({
      status: "pending",
      state: "VERIFY_WAITING",
    });
    expect(h.fake.comments).toHaveLength(1);
    expect(h.fake.comments[0]?.body).toContain("@po");
    expect(h.fake.comments[0]?.body).toContain("verification waiting");
    await deployRelease(h.deps, request);
    expect(h.fake.comments).toHaveLength(1);
    const run = h.fake.deployRuns[0];
    if (run === undefined) throw new Error("run missing");
    run["status"] = "completed";
    run["conclusion"] = "success";
    h.fake.deployConclusion = "success";
    expect(await deployRelease(h.deps, request)).toMatchObject({ status: "verified" });
  });
  it("requires native approval evidence before reporting success", async () => {
    const h = setup();
    h.fake.deployNativeApproved = false;
    expect(await deployRelease(h.deps, request)).toMatchObject({ status: "failed" });
  });
  it("requires a current approved runbook revision for rollback", async () => {
    const h = setup();
    const deployApproval = h.getApproval();
    const subject = {
      kind: "business" as const,
      baselineHash: "c".repeat(64),
      scopeIds: ["rollback-sandbox-r1"],
    };
    const approval: ApprovalRequest = {
      id: "runbook-1",
      subjectId: "runbook-1",
      subjectHash: approvalSubjectHash(subject),
      subject,
      status: "approved",
      version: 1,
      requestedAt: h.clock.ms,
      decision: {
        id: "runbook-1",
        subject,
        decision: "approved",
        actor: "po",
        source: "github-actor",
        decidedAt: h.clock.ms,
      },
    };
    const deps = {
      ...h.deps,
      approvals: { get: (id: string) => (id === "runbook-1" ? approval : deployApproval) },
      runbooks: {
        read: () => ({
          reference: "rollback-sandbox-r1",
          revisionHash: "c".repeat(64),
          repository: request.repository,
          environment: "sandbox",
          previousDigest: digest,
        }),
      },
    };
    const rollback = { runbookRef: "rollback-sandbox-r1", approvalId: "runbook-1" };
    expect(await deployRelease(deps, { ...request, rollback })).toMatchObject({
      status: "verified",
    });
    expect(
      await deployRelease(
        {
          ...deps,
          runbooks: { read: () => ({ ...deps.runbooks.read(), revisionHash: "d".repeat(64) }) },
        },
        { ...request, rollback },
      ),
    ).toMatchObject({ status: "refused", reason: "RUNBOOK_NOT_APPROVED" });
  });

  it("deploys A, B, then rolls back to A with a new approved run and deployment", async () => {
    const h = setup();
    const first = expectVerified(await deployRelease(h.deps, request));
    const b = approveDigest(h, `sha256:${"b".repeat(64)}`, "deploy-b");
    const second = expectVerified(await deployRelease(h.deps, b));
    const a = approveDigest(h, digest, "rollback-a");
    const deployApproval = h.getApproval();
    const subject = {
      kind: "business" as const,
      baselineHash: "c".repeat(64),
      scopeIds: ["rollback-sandbox-r1"],
    };
    const runbookApproval: ApprovalRequest = {
      id: "runbook-1",
      subjectId: "runbook-1",
      subjectHash: approvalSubjectHash(subject),
      subject,
      status: "approved",
      version: 1,
      requestedAt: h.clock.ms,
      decision: {
        id: "runbook-1",
        subject,
        decision: "approved",
        actor: "po",
        source: "github-actor",
        decidedAt: h.clock.ms,
      },
    };
    const deps = {
      ...h.deps,
      approvals: {
        get: (id: string) =>
          id === "runbook-1" ? runbookApproval : id === a.approvalId ? deployApproval : undefined,
      },
      runbooks: {
        read: () => ({
          reference: "rollback-sandbox-r1",
          revisionHash: "c".repeat(64),
          repository: request.repository,
          environment: "sandbox",
          previousDigest: digest,
        }),
      },
    };
    const rollback = {
      ...a,
      rollback: { runbookRef: "rollback-sandbox-r1", approvalId: "runbook-1" },
    };
    const restored = expectVerified(await deployRelease(deps, rollback));
    expect(restored.artifactDigest).toBe(digest);
    expect(restored.runId).not.toBe(first.runId);
    expect(restored.runId).not.toBe(second.runId);
    expect(restored.deploymentId).not.toBe(first.deploymentId);
    expect(expectVerified(await deployRelease(deps, rollback)).runId).toBe(restored.runId);
    expect(
      h.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
    ).toHaveLength(3);
  });
  it("redeploys A after B with a fresh approval instead of reusing old evidence", async () => {
    const h = setup();
    const first = expectVerified(await deployRelease(h.deps, request));
    const b = approveDigest(h, `sha256:${"b".repeat(64)}`, "deploy-b");
    expectVerified(await deployRelease(h.deps, b));
    const a = approveDigest(h, digest, "deploy-a-again");
    const redeployed = expectVerified(await deployRelease(h.deps, a));
    expect(redeployed.runId).not.toBe(first.runId);
    expect(redeployed.deploymentId).not.toBe(first.deploymentId);
    expect(expectVerified(await deployRelease(h.deps, a)).runId).toBe(redeployed.runId);
    expect(
      h.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
    ).toHaveLength(3);
  });
  it("retries a failed digest only as a new approved intent", async () => {
    const h = setup();
    h.fake.deployConclusion = "failure";
    expect(await deployRelease(h.deps, request)).toMatchObject({ status: "failed" });
    expect(await deployRelease(h.deps, request)).toMatchObject({ status: "failed" });
    h.fake.deployConclusion = "success";
    const retry = approveDigest(h, digest, "deploy-retry");
    await expect(deployRelease(h.deps, retry)).resolves.toMatchObject({ status: "verified" });
    expect(
      h.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
    ).toHaveLength(2);
  });
  it("notifies the PO at ten minutes even before the polling budget expires", async () => {
    const h = setup();
    h.fake.deployStatus = "waiting";
    h.fake.deployConclusion = null;
    let sleeps = 0;
    const deps = {
      ...h.deps,
      maxPolls: 4,
      pollIntervalMs: 360000,
      sleep: (ms: number) => {
        h.clock.ms += ms;
        sleeps += 1;
        if (sleeps === 3) {
          expect(h.fake.comments).toHaveLength(1);
          const run = h.fake.deployRuns[0];
          if (run === undefined) throw new Error("run missing");
          run["status"] = "completed";
          run["conclusion"] = "success";
          h.fake.deployConclusion = "success";
        }
        return Promise.resolve();
      },
    };
    expectVerified(await deployRelease(deps, request));
    expect(h.fake.comments).toHaveLength(1);
    expect(h.fake.comments[0]?.body).toContain("verification waiting");
  });
  it("reconciles a lost waiting-notice response after a restart without duplicate reports", async () => {
    const h = setup();
    h.fake.deployStatus = "waiting";
    h.fake.deployConclusion = null;
    h.fake.inject({
      method: "POST",
      pathIncludes: "/comments",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    expect(await deployRelease(h.deps, request)).toMatchObject({
      status: "pending",
      notification: "pending",
    });
    expect(await deployRelease({ ...h.deps }, request)).toMatchObject({
      status: "pending",
      notification: "succeeded",
    });
    expect(h.fake.comments).toHaveLength(1);
    expect(
      h.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
    ).toHaveLength(1);
  });
  it("reports a later terminal failure separately from the waiting notice", async () => {
    const h = setup();
    h.fake.deployStatus = "waiting";
    h.fake.deployConclusion = null;
    await deployRelease(h.deps, request);
    const run = h.fake.deployRuns[0];
    if (run === undefined) throw new Error("run missing");
    run["status"] = "completed";
    run["conclusion"] = "timed_out";
    h.fake.deployConclusion = "timed_out";
    expect(await deployRelease(h.deps, request)).toMatchObject({ status: "failed" });
    expect(h.fake.comments).toHaveLength(2);
  });
  it("rejects mutable artifact labels at the boundary", async () => {
    const h = setup();
    await expect(deployRelease(h.deps, { ...request, artifactDigest: "latest" })).rejects.toThrow();
    expect(h.fake.requests).toHaveLength(0);
  });
});
