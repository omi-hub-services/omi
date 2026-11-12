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
    approvals: { get: () => approval },
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
    expect(h.fake.comments).toHaveLength(0);
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
  it.each([false, true])(
    "binds rollback to its own approved intent (prior forward deploy: %s)",
    async (priorForwardDeploy) => {
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
      if (priorForwardDeploy) {
        await deployRelease(h.deps, request);
        expect(await deployRelease(deps, { ...request, rollback })).toMatchObject({
          status: "refused",
          reason: "OPERATION_KEY_CONFLICT",
        });
        expect(
          h.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")),
        ).toHaveLength(1);
        return;
      }
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
    },
  );
  it("rejects mutable artifact labels at the boundary", async () => {
    const h = setup();
    await expect(deployRelease(h.deps, { ...request, artifactDigest: "latest" })).rejects.toThrow();
    expect(h.fake.requests).toHaveLength(0);
  });
});
