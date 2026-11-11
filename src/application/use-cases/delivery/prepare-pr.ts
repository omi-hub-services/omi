import { acceptanceCriteria } from "../../../domain/tasks/acceptance-criteria.js";
import { operationMarker } from "../../../domain/delivery/operation-marker.js";
import { githubOperationSchema } from "../../contracts/github-operation.js";
import type { GithubOperation } from "../../contracts/github-operation.js";
import {
  deliveryPullSchema,
  preparePrSchema,
  prMappingSchema,
  pullRequestCreationKey,
} from "../../contracts/pr-delivery.js";
import type { PrMapping } from "../../contracts/pr-delivery.js";
import { DeliveryError } from "../../ports/pr-delivery.js";
import type { PrDeliveryReader, PrMappingStore } from "../../ports/pr-delivery.js";
import {
  deliverGithubOperation,
  reconcileGithubOperation,
} from "../../services/deliver-github-operation.js";
import type { DeliverGithubOperationDeps } from "../../services/deliver-github-operation.js";

export type PreparePrDeps = DeliverGithubOperationDeps & {
  readonly reader: PrDeliveryReader;
  readonly mappings: PrMappingStore;
};
export type PreparePrResult =
  | { readonly status: "verified"; readonly mapping: PrMapping }
  | { readonly status: "pending"; readonly operationKey: string; readonly state: string };

/** Run serially on the runtime writer. Every write is a durable intent before remote I/O. */
export async function preparePr(deps: PreparePrDeps, input: unknown): Promise<PreparePrResult> {
  const request = preparePrSchema.parse(input);
  const { repository, issueNumber, projectId, taskId, head } = request;
  const criteria = acceptanceCriteria(await deps.reader.issueBody(repository, issueNumber));
  if (criteria.length === 0) throw new DeliveryError("AC_SECTION_EMPTY_OR_MISSING");
  if (criteria.length !== request.evidence.length) throw new DeliveryError("AC_EVIDENCE_MISMATCH");
  const body = [
    `Issue: #${String(issueNumber)}`,
    `Task: ${taskId}`,
    "",
    "## Acceptance criteria and evidence",
    ...criteria.map(
      (criterion, index) =>
        `AC-${String(index + 1)}: ${criterion}\nEvidence: ${request.evidence[index] ?? ""}`,
    ),
  ].join("\n");
  // Untrusted criterion/evidence text must not introduce automatic closing references either.
  if (
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#|[\w.-]+\/[\w.-]+#|https:\/\/github\.com\/)/i.test(
      body,
    )
  )
    throw new DeliveryError("CLOSING_REFERENCE_FORBIDDEN");
  const key = pullRequestCreationKey(repository, taskId, head);
  operationMarker(key);
  const backlinkKey = `${key}:backlink`;
  operationMarker(backlinkKey);
  const operation = githubOperationSchema.parse({
    type: "pull_request.create",
    repo: repository,
    head,
    base: "develop",
    title: request.title,
    body,
  });
  const previous = deps.mappings.get(projectId, taskId);
  if (
    previous !== undefined &&
    (previous.repository !== repository || previous.issueNumber !== issueNumber)
  )
    throw new DeliveryError("MAPPING_CONFLICT");
  let pull = await deps.reader.findOpenPull(repository, head, "develop");
  if (pull === undefined) {
    if (previous !== undefined) throw new DeliveryError("MAPPED_PR_NOT_OPEN");
    const pending = await deliver(deps, key, operation);
    if (pending !== undefined) return pending;
    pull = await deps.reader.findOpenPull(repository, head, "develop");
    if (pull === undefined) throw new DeliveryError("PR_NOT_FOUND_AFTER_WRITE");
  }
  const verified = deliveryPullSchema.parse(await deps.reader.pull(repository, pull.number));
  if (
    verified.number !== pull.number ||
    verified.repository !== repository ||
    verified.head !== head ||
    verified.base !== "develop" ||
    verified.state !== "open" ||
    (verified.body !== body && verified.body !== `${body}\n\n${operationMarker(key)}`)
  )
    throw new DeliveryError("PR_VERIFICATION_FAILED");
  if (previous !== undefined && previous.prNumber !== verified.number)
    throw new DeliveryError("MAPPING_CONFLICT");
  await reconcileGithubOperation(deps, key);
  const backlink = `PR: https://github.com/${repository}/pull/${String(verified.number)}\nTask: ${taskId}\nIssue: #${String(issueNumber)}`;
  if (!(await deps.reader.hasBacklink(repository, issueNumber, backlink, backlinkKey))) {
    const pending = await deliver(deps, backlinkKey, {
      type: "issue.comment",
      repo: repository,
      issueNumber,
      body: backlink,
    });
    if (pending !== undefined) return pending;
    if (!(await deps.reader.hasBacklink(repository, issueNumber, backlink, backlinkKey)))
      throw new DeliveryError("BACKLINK_VERIFICATION_FAILED");
  }
  await reconcileGithubOperation(deps, backlinkKey);
  const mapping = prMappingSchema.parse({
    projectId,
    taskId,
    repository,
    issueNumber,
    prNumber: verified.number,
  });
  deps.mappings.save(mapping);
  const saved = prMappingSchema.safeParse(deps.mappings.get(projectId, taskId));
  if (!saved.success || JSON.stringify(saved.data) !== JSON.stringify(mapping))
    throw new DeliveryError("MAPPING_VERIFICATION_FAILED");
  return { status: "verified", mapping };
}

async function deliver(
  deps: PreparePrDeps,
  key: string,
  operation: GithubOperation,
): Promise<Extract<PreparePrResult, { status: "pending" }> | undefined> {
  const outcome = await deliverGithubOperation(deps, key, operation);
  if (outcome.kind === "failed") throw new DeliveryError(outcome.code);
  return outcome.kind === "succeeded"
    ? undefined
    : { status: "pending", operationKey: outcome.operationKey, state: outcome.state };
}
