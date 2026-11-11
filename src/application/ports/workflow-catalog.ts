import type { Workflow } from "../contracts/workflow.js";

export interface PinnedWorkflow {
  readonly workflow: Workflow;
  /** sha-256 of the template bytes; a run pins it. */
  readonly hash: string;
}

/** The workflow templates this project may run. Infrastructure loads and hashes them. */
export interface WorkflowCatalog {
  byId(id: string): PinnedWorkflow | undefined;
  byHash(hash: string): PinnedWorkflow | undefined;
}
