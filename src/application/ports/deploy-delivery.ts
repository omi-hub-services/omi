import type { GithubOperation } from "../contracts/github-operation.js";
import type { DeployEvidence, RollbackRunbook } from "../contracts/deploy-delivery.js";

export type DeployOperation = Extract<GithubOperation, { type: "deploy.dispatch" }>;
export interface DeployReader {
  /** Identity checked run, native approvals, digest-bound deployment and latest status. */
  evidence(
    operation: DeployOperation,
    operationKey: string,
    runId: number,
  ): Promise<DeployEvidence>;
}
export interface RollbackRunbookReader {
  read(reference: string): RollbackRunbook | undefined;
}
