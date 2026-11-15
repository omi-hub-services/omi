import type { ApprovalRequest } from "../../domain/approvals/approval.js";
import type { TaskComplexity } from "../contracts/task-complexity.js";
import type { ContextPacket } from "../contracts/context.js";

export interface DispatchTaskSource {
  read(taskId: string): Promise<
    | {
        readonly issue: ContextPacket["taskSnapshot"];
        readonly approvals: readonly ApprovalRequest[];
        readonly complexity?: TaskComplexity;
      }
    | undefined
  >;
}
