import { z } from "zod";
import { identifierSchema } from "./identifiers.js";
import { githubOperationSchema } from "./github-operation.js";

const pullOperation = githubOperationSchema.options[3];
export const preparePrSchema = z.strictObject({
  projectId: identifierSchema,
  taskId: identifierSchema,
  repository: pullOperation.shape.repo,
  issueNumber: z.number().int().positive(),
  head: pullOperation.shape.head,
  title: pullOperation.shape.title,
  evidence: z.array(z.string().trim().min(1).max(10_000)).max(1000),
});
export const deliveryPullSchema = z.strictObject({
  number: z.number().int().positive(),
  body: z.string(),
  head: z.string(),
  base: z.string(),
  repository: pullOperation.shape.repo,
  state: z.enum(["open", "closed"]),
});
export const prMappingSchema = z.strictObject({
  projectId: identifierSchema,
  taskId: identifierSchema,
  repository: pullOperation.shape.repo,
  issueNumber: z.number().int().positive(),
  prNumber: z.number().int().positive(),
});
/**
 * The outbox key of a task's PR creation intent. `preparePr` creates the PR under it (its marker
 * is on the PR body); a `pull_request.merge` names it to correlate the merge to that PR.
 */
export function pullRequestCreationKey(repository: string, taskId: string, head: string): string {
  return `create-pr:${repository}:${taskId}:${head}:develop`;
}
export type DeliveryPull = z.infer<typeof deliveryPullSchema>;
export type PrMapping = z.infer<typeof prMappingSchema>;
