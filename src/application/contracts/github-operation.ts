import { z } from "zod";
import { githubIdSchema } from "./project-config.js";

/**
 * Payload of one GitHub outbox operation, stored as an immutable artifact whose path and sha-256
 * are the outbox row's `payload_ref` / `payload_hash`. The text of `body` is Issue/PR content
 * written by the runtime; the marker that identifies the operation is added by the adapter and is
 * never part of the payload.
 */
const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/name");
const positiveInt = z.number().int().positive();
// GitHub rejects a comment or Issue body above 65536 characters; stay below with room for the marker.
const bodySchema = z.string().max(60_000);
const titleSchema = z.string().min(1).max(256);
const branchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/, "must be a plain branch name");

export const githubOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("project.copy"),
    sourceProjectId: githubIdSchema,
    ownerId: githubIdSchema,
    title: z.string().min(1).max(100),
  }),
  z.strictObject({
    type: z.literal("issue.comment"),
    repo: repoSchema,
    issueNumber: positiveInt,
    body: bodySchema.min(1),
  }),
  z.strictObject({
    type: z.literal("issue.create"),
    repo: repoSchema,
    title: titleSchema,
    body: bodySchema,
    labels: z.array(z.string().min(1).max(50)).max(20).optional(),
  }),
  z.strictObject({
    type: z.literal("pull_request.create"),
    repo: repoSchema,
    /** A branch of `repo` itself; fork heads are not supported. */
    head: branchSchema,
    base: branchSchema,
    title: titleSchema,
    body: bodySchema,
  }),
]);
export type GithubOperation = z.infer<typeof githubOperationSchema>;
export type GithubOperationType = GithubOperation["type"];

export const githubOperationPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: githubOperationSchema,
});
export type GithubOperationPayload = z.infer<typeof githubOperationPayloadSchema>;

export type PayloadRefusal = "PAYLOAD_NOT_JSON" | "PAYLOAD_INVALID" | "KIND_MISMATCH";

/** Parses payload bytes and checks them against the row's `kind`. Never throws. */
export function parseGithubOperationPayload(
  bytes: Uint8Array,
  kind: string,
):
  | { readonly ok: true; readonly operation: GithubOperation }
  | { readonly ok: false; readonly reason: PayloadRefusal } {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: "PAYLOAD_NOT_JSON" };
  }
  const parsed = githubOperationPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "PAYLOAD_INVALID" };
  if (parsed.data.operation.type !== kind) return { ok: false, reason: "KIND_MISMATCH" };
  return { ok: true, operation: parsed.data.operation };
}
