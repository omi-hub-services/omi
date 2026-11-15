import { z } from "zod";
import { gitShaSchema } from "../../application/contracts/identifiers.js";
import type { GithubOperation } from "../../application/contracts/github-operation.js";
import type { LookupOutcome, SendOutcome } from "../../application/ports/github-remote.js";
import { hasOperationMarker, operationMarker } from "../../domain/delivery/operation-marker.js";
import { writeOutcome } from "./github-rest-client.js";
import type { GithubRestClient, RestResult } from "./github-rest-client.js";

/**
 * Tag and GitHub Release creation (OMI-039). Both look before they write, and the read-back
 * is the remote state itself: the tag ref must point at the exact commit, the release of that tag
 * name must carry this operation's marker. A tag or release that exists but does not match is a
 * conflict that is refused, never adopted and never duplicated.
 */
export type ReleaseArtifactOperation = Extract<
  GithubOperation,
  { type: "git_tag.create" | "release.create" }
>;

export function isReleaseArtifactOperation(
  operation: GithubOperation,
): operation is ReleaseArtifactOperation {
  return operation.type === "git_tag.create" || operation.type === "release.create";
}

const refSchema = z.looseObject({
  ref: z.string(),
  object: z.looseObject({ sha: gitShaSchema, type: z.string() }),
});
const releaseSchema = z.looseObject({
  id: z.number().int().positive(),
  tag_name: z.string(),
  body: z.string().nullable(),
  draft: z.boolean().optional(),
});

type TagRead =
  | { readonly kind: "absent" }
  | { readonly kind: "at"; readonly sha: string }
  | { readonly kind: "unavailable"; readonly code: string };

const NOT_FOUND = "HTTP_404";

async function readTag(client: GithubRestClient, repo: string, tag: string): Promise<TagRead> {
  const result = await client.request({
    method: "GET",
    path: `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
  });
  if (result.kind === "rejected" && result.code === NOT_FOUND) return { kind: "absent" };
  if (result.kind !== "ok")
    return { kind: "unavailable", code: result.kind === "rejected" ? result.code : result.code };
  const parsed = refSchema.safeParse(result.json);
  if (!parsed.success || parsed.data.ref !== `refs/tags/${tag}`)
    return { kind: "unavailable", code: "INVALID_RESPONSE" };
  // An annotated tag points at a tag object, never at the commit: treated as a different target.
  return { kind: "at", sha: parsed.data.object.type === "commit" ? parsed.data.object.sha : "" };
}

const tagIdentity = (op: { repo: string; tag: string; sha: string }): string =>
  `git_tag:${op.repo}:${op.tag}:${op.sha}`;
const releaseIdentity = (repo: string, id: number): string => `release:${repo}:${String(id)}`;

type ReleaseRead =
  | { readonly kind: "absent" }
  | { readonly kind: "found"; readonly id: number }
  | { readonly kind: "unavailable"; readonly code: string };

async function readRelease(
  client: GithubRestClient,
  operation: Extract<ReleaseArtifactOperation, { type: "release.create" }>,
  operationKey: string,
): Promise<ReleaseRead> {
  const result = await client.request({
    method: "GET",
    path: `repos/${operation.repo}/releases/tags/${encodeURIComponent(operation.tag)}`,
  });
  if (result.kind === "rejected" && result.code === NOT_FOUND) return { kind: "absent" };
  if (result.kind !== "ok") return { kind: "unavailable", code: result.code };
  const parsed = releaseSchema.safeParse(result.json);
  if (!parsed.success || parsed.data.tag_name !== operation.tag)
    return { kind: "unavailable", code: "INVALID_RESPONSE" };
  // A release for this tag that this operation did not write is someone else's: never adopt it.
  if (!hasOperationMarker(parsed.data.body ?? "", operationKey))
    return { kind: "unavailable", code: "RELEASE_EXISTS_UNMARKED" };
  return { kind: "found", id: parsed.data.id };
}

export async function lookupReleaseArtifact(
  client: GithubRestClient,
  operation: ReleaseArtifactOperation,
  operationKey: string,
): Promise<LookupOutcome> {
  if (operation.type === "git_tag.create") {
    const tag = await readTag(client, operation.repo, operation.tag);
    if (tag.kind === "unavailable") return tag;
    if (tag.kind === "absent") return { kind: "absent" };
    return tag.sha === operation.sha
      ? { kind: "found", remoteIdentity: tagIdentity(operation) }
      : { kind: "unavailable", code: "TAG_POINTS_ELSEWHERE" };
  }
  const release = await readRelease(client, operation, operationKey);
  return release.kind === "found"
    ? { kind: "found", remoteIdentity: releaseIdentity(operation.repo, release.id) }
    : release;
}

export async function sendReleaseArtifact(
  client: GithubRestClient,
  operation: ReleaseArtifactOperation,
  operationKey: string,
): Promise<SendOutcome> {
  const prior = await lookupReleaseArtifact(client, operation, operationKey);
  if (prior.kind === "found") return { kind: "succeeded", remoteIdentity: prior.remoteIdentity };
  if (prior.kind === "unavailable") {
    return prior.code === "TAG_POINTS_ELSEWHERE" || prior.code === "RELEASE_EXISTS_UNMARKED"
      ? { kind: "rejected_final", code: prior.code }
      : { kind: "outcome_unknown", code: prior.code };
  }
  if (operation.type === "git_tag.create") {
    const result = await client.request({
      method: "POST",
      path: `repos/${operation.repo}/git/refs`,
      body: { ref: `refs/tags/${operation.tag}`, sha: operation.sha },
    });
    return confirmed(result, () => lookupReleaseArtifact(client, operation, operationKey));
  }
  // The release must name a tag that already points at the exact commit; never let GitHub
  // create the tag implicitly from a branch.
  const tag = await readTag(client, operation.repo, operation.tag);
  if (tag.kind === "unavailable") return { kind: "outcome_unknown", code: tag.code };
  if (tag.kind === "absent" || tag.sha !== operation.sha)
    return { kind: "rejected_final", code: "TAG_NOT_AT_COMMIT" };
  const result = await client.request({
    method: "POST",
    path: `repos/${operation.repo}/releases`,
    body: {
      tag_name: operation.tag,
      name: operation.title,
      body:
        operation.body === ""
          ? operationMarker(operationKey)
          : `${operation.body}\n\n${operationMarker(operationKey)}`,
      draft: false,
      prerelease: false,
    },
  });
  return confirmed(result, () => lookupReleaseArtifact(client, operation, operationKey));
}

/** A success body is not evidence; read the remote back, as pull merges do. */
async function confirmed(
  result: RestResult,
  readBack: () => Promise<LookupOutcome>,
): Promise<SendOutcome> {
  const outcome = writeOutcome(result, () => "written");
  if (outcome.kind !== "succeeded") return outcome;
  const found = await readBack();
  return found.kind === "found"
    ? { kind: "succeeded", remoteIdentity: found.remoteIdentity }
    : { kind: "outcome_unknown", code: "ARTIFACT_UNCONFIRMED" };
}
