import type { GithubOperation } from "../contracts/github-operation.js";
import { ProjectInitializationError } from "../ports/github-project-reader.js";
import { DeliveryError } from "../ports/pr-delivery.js";
import { queueGithubOperation } from "./queue-github-operation.js";
import type { GithubOperationQueueDeps } from "./queue-github-operation.js";

export type ProjectTemplateQueueDeps = GithubOperationQueueDeps;

/** Project initialization preserves its public error contract over the shared intent queue. */
export function queueProjectTemplate(
  deps: ProjectTemplateQueueDeps,
  operationKey: string,
  input: Extract<GithubOperation, { type: "project.copy" }>,
): { state: string; remoteIdentity: string | null } {
  try {
    return queueGithubOperation(deps, operationKey, input);
  } catch (error) {
    if (error instanceof DeliveryError) throw new ProjectInitializationError(error.code);
    throw error;
  }
}
