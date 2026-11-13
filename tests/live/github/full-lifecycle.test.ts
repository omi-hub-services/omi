// Opt-in only. Branch work/review and authenticated durable approvals are prepared externally.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { deployPipelineSchema } from "../../../src/application/contracts/deploy-delivery.ts";
import { mergeEvidenceSchema } from "../../../src/application/contracts/merge-delivery.ts";
import { preparePrSchema } from "../../../src/application/contracts/pr-delivery.ts";
import { prepareReleaseSchema } from "../../../src/application/contracts/release-delivery.ts";
import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";
import { deliverGithubOperation } from "../../../src/application/services/deliver-github-operation.ts";
import { preparePr } from "../../../src/application/use-cases/delivery/prepare-pr.ts";
import { mergeTaskPr } from "../../../src/application/use-cases/delivery/merge-task-pr.ts";
import { prepareRelease } from "../../../src/application/use-cases/delivery/prepare-release.ts";
import { checkReleaseMerge } from "../../../src/application/use-cases/delivery/check-release-merge.ts";
import { publishRelease } from "../../../src/application/use-cases/delivery/publish-release.ts";
import { deployRelease } from "../../../src/application/use-cases/delivery/deploy-release.ts";
import { checkExecutionApprovals } from "../../../src/application/services/check-execution-approvals.ts";
import type { TaskStatus } from "../../../src/domain/tasks/task-status.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createGhApiTransport } from "../../../src/infrastructure/github/gh-api-transport.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubPrDelivery } from "../../../src/infrastructure/github/github-pr-delivery.ts";
import { createGithubMergeDelivery } from "../../../src/infrastructure/github/github-merge-delivery.ts";
import { createGithubReleaseReader } from "../../../src/infrastructure/github/github-release-reader.ts";
import { createGithubReleaseMergeReader } from "../../../src/infrastructure/github/github-release-merge.ts";
import { createGithubDeployReader } from "../../../src/infrastructure/github/github-deploy.ts";
import { createSqliteApprovalStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createSqlitePrMappingStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-pr-mapping-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { assertLifecycleApiCall } from "./lifecycle-api-guard.ts";
import { decideReleaseResume, decideTaskResume } from "./lifecycle-resume.ts";
import { runtimeLayout } from "../../../tools/sandbox-setup/runtime-layout.ts";
import { assertSandboxTarget } from "./probe-model.ts";

const config = process.env["OMI_LIVE_LIFECYCLE_CONFIG"];
it.skipIf(config === undefined)(
  "accepts a full sandbox lifecycle with real PO gates (live)",
  async () => {
    if (!config?.trim()) throw new Error("OMI_LIVE_LIFECYCLE_CONFIG must name a JSON file");
    const c = z
      .strictObject({
        repository: z.literal("omi-hub-services/omi-sandbox"),
        acceptanceId: z.string().regex(/^[a-z0-9-]+$/),
        stateDirectory: z.string().min(1),
        projectId: preparePrSchema.shape.projectId,
        taskId: preparePrSchema.shape.taskId,
        idea: z.string().min(1).max(256),
        issueBody: z.string().min(1).max(60000),
        baselineHash: z.string().regex(/^[a-f0-9]{64}$/),
        businessApprovalId: z.string().min(1),
        head: preparePrSchema.shape.head,
        evidence: preparePrSchema.shape.evidence,
        reviewFile: z.string().min(1),
        requiredChecks: z.array(z.string().min(1)).min(1),
        release: prepareReleaseSchema.shape.release,
        artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        deployApprovalId: z.string().min(1),
        pipeline: deployPipelineSchema,
        timeoutSeconds: z.number().int().min(30).max(1800).default(600),
      })
      .parse(JSON.parse(readFileSync(resolve(config), "utf8")));
    assertSandboxTarget({ repo: c.repository, projectOwner: "omi-hub-services", projectNumber: 2 });
    if (
      c.pipeline.allowedActors.length !== 1 ||
      c.pipeline.allowedActors[0] !== "ttin-omihub" ||
      c.pipeline.authorActor.toLowerCase() === "ttin-omihub"
    )
      throw new Error("separate author and PO required");
    const review = mergeEvidenceSchema.parse(
      JSON.parse(readFileSync(resolve(c.reviewFile), "utf8")),
    );
    if (review.review === undefined) throw new Error("independent review required");
    const stateDir = resolve(c.stateDirectory);
    const layout = runtimeLayout(stateDir);
    if (!existsSync(layout.database) || !existsSync(layout.artifactsRoot))
      throw new Error("prepare migrated sandbox state and authenticated approvals first");
    const db = openStateDatabase(layout.database);
    const state = createSqliteStateUnitOfWork(db);
    const leases = createSqliteLeaseStore(db);
    const approvals = createSqliteApprovalStore(db);
    const transport = createGhApiTransport();
    const base = `repos/${c.repository}`;
    const report: Record<string, unknown> = {
      acceptanceId: c.acceptanceId,
      repository: c.repository,
    };
    const evidenceDir = resolve(import.meta.dirname, "../../../.tmp/live");
    mkdirSync(evidenceDir, { recursive: true });
    const save = () => {
      writeFileSync(
        join(evidenceDir, `omi-042-${c.acceptanceId}.json`),
        JSON.stringify(report, null, 2) + "\n",
        { mode: 0o600 },
      );
    };
    const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
    const rest = createGithubRestClient({
      transport: {
        send(call) {
          assertLifecycleApiCall(call, c.repository, c.pipeline.workflow);
          return transport.send(call);
        },
      },
      now: Date.now,
      random: Math.random,
      sleep,
    });
    const reader = createGithubMergeDelivery(rest);
    const session = claimProjectSession({
      leases,
      state,
      owner: randomUUID(),
      now: Date.now,
      nextId: randomUUID,
      leaseMs: 60000,
    });
    const deps = {
      artifacts: createLocalArtifactStore(layout.artifactsRoot, db),
      outbox: createSqliteOutboxStore(db),
      unitOfWork: state,
      github: createGithubRemote(rest),
      now: Date.now,
      newId: randomUUID,
      newEventId: randomUUID,
      reconcileGraceMs: 60000,
      retryBudget: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60000 },
      jitter: Math.random,
      batchSize: 1,
    };
    async function waitFor(gate: string, url: string, probe: () => Promise<boolean>) {
      console.log(`waiting for PO approval at ${gate}: ${url}`);
      const deadline = Date.now() + c.timeoutSeconds * 1000;
      while (Date.now() < deadline) {
        if (!session.renew()) throw new Error("project writer lost");
        if (await probe()) return;
        await sleep(5000);
      }
      throw new Error(`Timed out at ${gate}: ${url}; retain state, inspect evidence before retry`);
    }
    try {
      const actor = await reader.authenticatedActor();
      if (
        actor.toLowerCase() !== c.pipeline.authorActor.toLowerCase() ||
        actor.toLowerCase() === "ttin-omihub"
      )
        throw new Error("authenticate only the configured agent account; never use PO credentials");
      const business = approvals.get(c.businessApprovalId);
      expect(business?.status).toBe("approved");
      expect(
        checkExecutionApprovals(
          {
            store: approvals,
            now: Date.now,
            subjects: {
              read: () => ({
                kind: "business",
                baselineHash: c.baselineHash,
                scopeIds: [c.taskId],
              }),
            },
          },
          [
            {
              approvalId: c.businessApprovalId,
              subjectId: business?.subjectId ?? "missing",
              kind: "business",
            },
          ],
          ["ttin-omihub"],
          actor,
        ),
      ).toEqual({ allowed: true });
      report["taskEvidence"] = review;
      report["deployIntent"] = {
        artifactDigest: c.artifactDigest,
        environment: "sandbox",
        approvalId: c.deployApprovalId,
        pipeline: c.pipeline,
      };
      report["idea"] = {
        title: c.idea,
        baselineHash: c.baselineHash,
        businessApprovalId: c.businessApprovalId,
      };
      const created = await deliverGithubOperation(deps, `lifecycle:${c.acceptanceId}:issue`, {
        type: "issue.create",
        repo: c.repository,
        title: c.idea,
        body: c.issueBody,
      });
      if (created.kind !== "succeeded") throw new Error("Issue creation pending; retain state");
      const issueNumber = Number(created.remoteIdentity?.split("#")[1]);
      expect(Number.isSafeInteger(issueNumber) && issueNumber > 0).toBe(true);
      report["issue"] = { issueNumber };
      save();
      const mappings = createSqlitePrMappingStore(db);
      const existing = mappings.get(c.projectId, c.taskId);
      const mappedPull =
        existing === undefined ? undefined : await reader.pull(c.repository, existing.prNumber);
      const taskResume = decideTaskResume({
        reviewedHeadSha: review.review.headSha,
        pull: mappedPull,
        onDevelop:
          mappedPull?.mergeCommitSha != null
            ? await reader.branchContains(c.repository, "develop", mappedPull.mergeCommitSha)
            : undefined,
      });
      if (taskResume.action === "skip") {
        report["develop"] = {
          status: "done",
          resumed: true,
          prNumber: taskResume.prNumber,
          mergeCommitSha: taskResume.mergeCommitSha,
        };
        save();
      } else {
        const prepared = await preparePr(
          { ...deps, mappings, reader: createGithubPrDelivery(rest) },
          {
            projectId: c.projectId,
            taskId: c.taskId,
            repository: c.repository,
            issueNumber,
            head: c.head,
            title: c.idea,
            evidence: c.evidence,
          },
        );
        if (prepared.status !== "verified") throw new Error("task PR pending; retain state");
        let taskStatus: TaskStatus = "in_progress";
        const taskResult = await mergeTaskPr(
          {
            ...deps,
            mappings,
            reader,
            leases,
            evidence: { read: () => review },
            tasks: {
              status: () => taskStatus,
              complete: (change) => {
                taskStatus = change.toStatus;
                return { ok: true };
              },
            },
            mergeLockOwner: "lifecycle-acceptance",
            mergeLockTtlMs: 60000,
          },
          {
            projectId: c.projectId,
            taskId: c.taskId,
            repository: c.repository,
            issueNumber,
            prNumber: prepared.mapping.prNumber,
            reviewedHeadSha: review.review.headSha,
            requiredChecks: c.requiredChecks,
          },
        );
        report["develop"] = taskResult;
        save();
        expect(taskResult.status).toBe("done");
      }
      const releases = createGithubReleaseReader(rest);
      const release = await prepareRelease(
        { ...deps, releases, pulls: createGithubPrDelivery(rest) },
        { repository: c.repository, release: c.release },
      );
      if (release.status !== "verified") throw new Error("release preparation pending");
      report["releasePlan"] = release;
      save();
      const head = (await reader.pull(c.repository, release.prNumber)).headSha;
      const releaseRequest = {
        repository: c.repository,
        prNumber: release.prNumber,
        expectedHeadSha: head,
        poActors: ["ttin-omihub"],
        requiredChecks: c.requiredChecks,
      };
      report["releaseRequest"] = releaseRequest;
      const releasePull = await reader.pull(c.repository, release.prNumber);
      const releaseResume = decideReleaseResume({
        pull: releasePull,
        onMain:
          releasePull.mergeCommitSha !== null
            ? await reader.branchContains(c.repository, "main", releasePull.mergeCommitSha)
            : undefined,
        reviews: await reader.nativeReviews(c.repository, release.prNumber),
        poActors: releaseRequest.poActors,
      });
      if (releaseResume.action === "skip") {
        report["releaseGate"] = { resumed: true, mergeCommitSha: releaseResume.mergeCommitSha };
      } else {
        await waitFor(
          "release",
          `https://github.com/${c.repository}/pull/${String(release.prNumber)}`,
          async () => {
            const result = await checkReleaseMerge(
              createGithubReleaseMergeReader(rest),
              releaseRequest,
            );
            report["releaseGate"] = result;
            save();
            return result.allowed;
          },
        );
      }
      report["releaseReviews"] = await reader.nativeReviews(c.repository, release.prNumber);
      save();
      // No product release merge use case exists. This harness performs the head-pinned native merge.
      if (releaseResume.action !== "skip") {
        const merge = await rest.request({
          method: "PUT",
          path: `${base}/pulls/${String(release.prNumber)}/merge`,
          body: { sha: head, merge_method: "merge" },
        });
        if (merge.kind !== "ok")
          throw new Error("release merge unconfirmed; inspect GitHub before retry");
      }
      const published = await publishRelease(
        { ...deps, releases, pulls: reader },
        { repository: c.repository, release: c.release, prNumber: release.prNumber },
      );
      report["release"] = published;
      save();
      expect(published.status).toBe("published");
      const deployRequest = {
        repository: c.repository,
        environment: "sandbox",
        artifactDigest: c.artifactDigest,
        approvalId: c.deployApprovalId,
      };
      const deployments = createGithubDeployReader(rest);
      await waitFor("deploy", `https://github.com/${c.repository}/actions`, async () => {
        const result = await deployRelease(
          {
            ...deps,
            session,
            approvals,
            pipeline: c.pipeline,
            deployments,
            hasher: { sha256: (text) => createHash("sha256").update(text).digest("hex") },
            sleep,
            maxPolls: 1,
            pollIntervalMs: 0,
          },
          deployRequest,
        );
        report["deploy"] = result;
        save();
        if (result.status === "failed" || result.status === "refused")
          throw new Error(`deploy ${result.status}: ${result.reason}`);
        if (result.status === "pending") {
          const intent = deps.outbox.get(result.operationKey);
          if (intent?.remoteIdentity)
            console.log(
              `waiting for PO approval at deploy: https://github.com/${c.repository}/actions/runs/${intent.remoteIdentity}`,
            );
        }
        return result.status === "verified";
      });
    } finally {
      save();
      session.release();
      db.close();
    }
  },
  4_000_000,
);
