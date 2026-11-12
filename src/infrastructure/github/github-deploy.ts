import { z } from "zod";
import type { DeployOperation, DeployReader } from "../../application/ports/deploy-delivery.js";
import type { LookupOutcome, SendOutcome } from "../../application/ports/github-remote.js";
import { DeliveryError } from "../../application/ports/pr-delivery.js";
import { gitShaSchema } from "../../application/contracts/identifiers.js";
import type { GithubRestClient } from "./github-rest-client.js";
import { writeOutcome } from "./github-rest-client.js";

const runSchema = z.looseObject({
  id: z.number().int().positive(),
  display_title: z.string(),
  event: z.string(),
  head_sha: gitShaSchema,
  path: z.string(),
  run_attempt: z.number().int().positive(),
  repository: z.looseObject({ full_name: z.string() }),
  actor: z.looseObject({ login: z.string() }),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
});
const payloadSchema = z.looseObject({
  operation_key: z.string(),
  artifact_digest: z.string(),
  run_id: z.number().int().positive(),
});
const deploymentSchema = z.looseObject({
  id: z.number().int().positive(),
  environment: z.string(),
  sha: gitShaSchema,
  payload: z.unknown(),
});
const approvalSchema = z.looseObject({
  state: z.string(),
  user: z.looseObject({ login: z.string() }),
  environments: z.array(z.looseObject({ name: z.string() })),
});
const environmentSchema = z.looseObject({
  name: z.string(),
  can_admins_bypass: z.boolean(),
  protection_rules: z.array(
    z.looseObject({
      type: z.string(),
      prevent_self_review: z.boolean().optional(),
      reviewers: z
        .array(
          z.looseObject({
            type: z.string(),
            reviewer: z.looseObject({ login: z.string().optional() }),
          }),
        )
        .optional(),
    }),
  ),
});
const equalActor = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const title = (key: string): string => `omi-deploy:${key}`;
const workflowPath = (op: DeployOperation): string =>
  `repos/${op.repo}/actions/workflows/${encodeURIComponent(op.workflow)}`;

function matches(run: z.infer<typeof runSchema>, op: DeployOperation, key: string): boolean {
  return (
    run.display_title === title(key) &&
    run.event === "workflow_dispatch" &&
    run.head_sha === op.workflowSha &&
    run.repository.full_name === op.repo &&
    run.path === `.github/workflows/${op.workflow}` &&
    run.run_attempt === 1 &&
    equalActor(run.actor.login, op.authorActor)
  );
}

async function runs(
  client: GithubRestClient,
  op: DeployOperation,
  key: string,
): Promise<number | undefined> {
  const found: number[] = [];
  const pages = await client.readPages(
    `${workflowPath(op)}/runs?event=workflow_dispatch&per_page=100`,
    (page) => {
      const parsed = z.looseObject({ workflow_runs: z.array(runSchema) }).safeParse(page);
      if (!parsed.success) return "invalid";
      for (const run of parsed.data.workflow_runs) {
        if (run.display_title !== title(key)) continue;
        if (!matches(run, op, key)) return "invalid";
        found.push(run.id);
      }
      return "continue";
    },
  );
  if (pages.kind !== "complete")
    throw new DeliveryError(pages.kind === "failed" ? pages.code : "SCAN_STOPPED");
  if (found.length > 1) throw new DeliveryError("DUPLICATE_DEPLOY_RUNS");
  return found[0];
}

/** An absent run never authorizes repeating a potentially accepted Actions dispatch. */
export async function lookupDeploy(
  client: GithubRestClient,
  op: DeployOperation,
  key: string,
): Promise<LookupOutcome> {
  try {
    const id = await runs(client, op, key);
    return id === undefined
      ? { kind: "unavailable", code: "DISPATCH_UNCONFIRMED" }
      : { kind: "found", remoteIdentity: String(id) };
  } catch (error) {
    return {
      kind: "unavailable",
      code: error instanceof DeliveryError ? error.code : "DEPLOY_READ_FAILED",
    };
  }
}

export async function sendDeploy(
  client: GithubRestClient,
  op: DeployOperation,
  key: string,
): Promise<SendOutcome> {
  let prior: number | undefined;
  try {
    prior = await runs(client, op, key);
  } catch {
    return { kind: "outcome_unknown", code: "DEPLOY_READ_FAILED" };
  }
  if (prior !== undefined) return { kind: "succeeded", remoteIdentity: String(prior) };
  const actorResult = await client.request({ method: "GET", path: "user" });
  const actor =
    actorResult.kind === "ok"
      ? z.looseObject({ login: z.string() }).safeParse(actorResult.json)
      : undefined;
  if (
    !actor?.success ||
    !equalActor(actor.data.login, op.authorActor) ||
    op.allowedActors.some((a) => equalActor(a, actor.data.login))
  )
    return { kind: "rejected_final", code: "DEPLOY_ACTOR_INVALID" };
  const result = await client.request({
    method: "GET",
    path: `repos/${op.repo}/environments/${encodeURIComponent(op.deploymentEnvironment)}`,
  });
  const environment = result.kind === "ok" ? environmentSchema.safeParse(result.json) : undefined;
  if (
    !environment?.success ||
    environment.data.name !== op.deploymentEnvironment ||
    environment.data.can_admins_bypass
  )
    return { kind: "rejected_final", code: "ENVIRONMENT_NOT_PROTECTED" };
  const rule = environment.data.protection_rules.find((r) => r.type === "required_reviewers");
  const reviewers = rule?.reviewers ?? [];
  if (
    rule?.prevent_self_review !== true ||
    reviewers.length === 0 ||
    reviewers.some(
      (r) =>
        r.type !== "User" || !op.allowedActors.some((a) => equalActor(a, r.reviewer.login ?? "")),
    )
  )
    return { kind: "rejected_final", code: "ENVIRONMENT_NOT_PROTECTED" };
  const tagResult = await client.request({
    method: "GET",
    path: `repos/${op.repo}/git/ref/tags/${encodeURIComponent(op.ref)}`,
  });
  const tag =
    tagResult.kind === "ok"
      ? z
          .looseObject({
            ref: z.string(),
            object: z.looseObject({ type: z.string(), sha: gitShaSchema }),
          })
          .safeParse(tagResult.json)
      : undefined;
  if (
    !tag?.success ||
    tag.data.ref !== `refs/tags/${op.ref}` ||
    tag.data.object.type !== "commit" ||
    tag.data.object.sha !== op.workflowSha
  )
    return { kind: "rejected_final", code: "WORKFLOW_REVISION_MISMATCH" };
  const sent = await client.request({
    method: "POST",
    path: `${workflowPath(op)}/dispatches`,
    body: {
      ref: op.ref,
      inputs: {
        environment: op.deploymentEnvironment,
        artifact_digest: op.artifactDigest,
        operation_key: key,
      },
    },
  });
  if (sent.kind !== "ok") return writeOutcome(sent, () => undefined);
  const confirmed = await lookupDeploy(client, op, key);
  return confirmed.kind === "found"
    ? { kind: "succeeded", remoteIdentity: confirmed.remoteIdentity }
    : { kind: "outcome_unknown", code: "DISPATCH_UNCONFIRMED" };
}

async function read(client: GithubRestClient, path: string): Promise<unknown> {
  const result = await client.request({ method: "GET", path });
  if (result.kind !== "ok") throw new DeliveryError(result.code);
  return result.json;
}

export function createGithubDeployReader(client: GithubRestClient): DeployReader {
  return {
    async evidence(op, key, runId) {
      const base = `repos/${op.repo}`;
      const run = runSchema.parse(await read(client, `${base}/actions/runs/${String(runId)}`));
      if (run.id !== runId || !matches(run, op, key))
        throw new DeliveryError("DEPLOY_RUN_MISMATCH");
      const approvals = z
        .array(approvalSchema)
        .parse(await read(client, `${base}/actions/runs/${String(runId)}/approvals`));
      const nativeApproved = approvals.some(
        (a) =>
          a.state === "approved" &&
          !equalActor(a.user.login, op.authorActor) &&
          op.allowedActors.some((p) => equalActor(a.user.login, p)) &&
          a.environments.some((e) => e.name === op.deploymentEnvironment),
      );
      const deployments: z.infer<typeof deploymentSchema>[] = [];
      const pages = await client.readPages(
        `${base}/deployments?environment=${encodeURIComponent(op.deploymentEnvironment)}&per_page=100`,
        (page) => {
          const parsed = z.array(deploymentSchema).safeParse(page);
          if (!parsed.success) return "invalid";
          deployments.push(...parsed.data);
          return "continue";
        },
      );
      if (pages.kind !== "complete") throw new DeliveryError("DEPLOYMENTS_UNAVAILABLE");
      const matched = deployments.filter((d) => {
        const payload = payloadSchema.safeParse(d.payload);
        return (
          payload.success && payload.data.operation_key === key && payload.data.run_id === runId
        );
      });
      if (matched.length > 1) throw new DeliveryError("DUPLICATE_DEPLOYMENTS");
      const deployment = matched[0];
      let deploymentStatus: string | null = null;
      if (deployment !== undefined) {
        const payload = payloadSchema.parse(deployment.payload);
        if (
          deployment.environment !== op.deploymentEnvironment ||
          deployment.sha !== op.workflowSha ||
          payload.artifact_digest !== op.artifactDigest
        )
          throw new DeliveryError("DEPLOY_DIGEST_MISMATCH");
        const statuses = z
          .array(z.looseObject({ state: z.string().min(1) }))
          .parse(
            await read(
              client,
              `${base}/deployments/${String(deployment.id)}/statuses?per_page=100`,
            ),
          );
        deploymentStatus = statuses[0]?.state ?? null;
      }
      return {
        runId,
        status: run.status,
        conclusion: run.conclusion,
        deploymentId: deployment?.id ?? null,
        deploymentStatus,
        artifactDigest: op.artifactDigest,
        nativeApproved,
      };
    },
  };
}
