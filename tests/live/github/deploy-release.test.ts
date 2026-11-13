import { claimProjectSession } from "../../../src/application/services/claim-project-session.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
// Explicit opt-in: dispatches only to the configured sandbox; the PO approves in GitHub.
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  deployPipelineSchema,
  deployReleaseSchema,
  rollbackRunbookSchema,
} from "../../../src/application/contracts/deploy-delivery.ts";
import { deployRelease } from "../../../src/application/use-cases/delivery/deploy-release.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createGhApiTransport } from "../../../src/infrastructure/github/gh-api-transport.ts";
import { createGithubDeployReader } from "../../../src/infrastructure/github/github-deploy.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { createSqliteApprovalStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { runtimeLayout } from "../../../tools/sandbox-setup/runtime-layout.ts";
import { assertSandboxTarget } from "./probe-model.ts";

const config = process.env["OMI_LIVE_DEPLOY_CONFIG"];
it.skipIf(config === undefined)(
  "deploys and verifies an approved immutable sandbox artifact (live)",
  async () => {
    if (!config?.trim())
      throw new Error("OMI_LIVE_DEPLOY_CONFIG must name a JSON configuration file");
    const parsed = z
      .strictObject({
        request: deployReleaseSchema,
        pipeline: deployPipelineSchema,
        stateDirectory: z.string().min(1),
        runbooks: z.array(rollbackRunbookSchema).default([]),
      })
      .parse(JSON.parse(readFileSync(resolve(config), "utf8")));
    const { request, pipeline } = parsed;
    const owner = request.repository.split("/")[0];
    if (owner === undefined || !/sandbox/i.test(request.repository))
      throw new Error("sandbox repository required");
    assertSandboxTarget({ repo: request.repository, projectOwner: owner, projectNumber: 2 });
    const stateDir = resolve(parsed.stateDirectory);
    const layout = runtimeLayout(stateDir);
    // Use a dedicated state directory with existing, authenticated approvals; never import decisions from JSON.
    if (!existsSync(layout.database) || !existsSync(layout.artifactsRoot))
      throw new Error("prepare dedicated live state and authenticated approvals first");
    const db = openStateDatabase(layout.database);
    const transport = createGhApiTransport();
    const base = `repos/${request.repository}`;
    const rest = createGithubRestClient({
      transport: {
        send(call) {
          const allowedRead =
            call.method === "GET" && (call.path === "user" || call.path.startsWith(`${base}/`));
          const allowedWrite =
            call.method === "POST" &&
            (call.path ===
              `${base}/actions/workflows/${encodeURIComponent(pipeline.workflow)}/dispatches` ||
              call.path === `${base}/issues/${String(pipeline.issueNumber)}/comments`);
          if (!allowedRead && !allowedWrite) throw new Error("sandbox API guard refused call");
          return transport.send(call);
        },
      },
      now: Date.now,
      random: Math.random,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    });
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(db),
      state: createSqliteStateUnitOfWork(db),
      owner: randomUUID(),
      now: Date.now,
      nextId: randomUUID,
      leaseMs: 60000,
    });
    try {
      const result = await deployRelease(
        {
          session,
          artifacts: createLocalArtifactStore(layout.artifactsRoot, db),
          outbox: createSqliteOutboxStore(db),
          unitOfWork: createSqliteStateUnitOfWork(db),
          approvals: createSqliteApprovalStore(db),
          deployments: createGithubDeployReader(rest),
          github: createGithubRemote(rest),
          pipeline,
          runbooks: { read: (reference) => parsed.runbooks.find((r) => r.reference === reference) },
          hasher: { sha256: (text) => createHash("sha256").update(text).digest("hex") },
          now: Date.now,
          newId: randomUUID,
          newEventId: randomUUID,
          reconcileGraceMs: 60000,
          retryBudget: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60000 },
          jitter: Math.random,
          batchSize: 1,
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
          maxPolls: 120,
          pollIntervalMs: 5000,
        },
        request,
      );
      const evidenceDir = resolve(import.meta.dirname, "../../../.tmp/live");
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, "omi-041-deploy-evidence.json"),
        JSON.stringify({ repository: request.repository, result }, null, 2) + "\n",
        { mode: 0o600 },
      );
      expect(result).toMatchObject({
        status: "verified",
        evidence: {
          artifactDigest: request.artifactDigest,
          conclusion: "success",
          deploymentStatus: "success",
          nativeApproved: true,
        },
      });
    } finally {
      session.release();
      db.close();
    }
  },
  900000,
);
