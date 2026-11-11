import { approvalSubjectSchema } from "../contracts/approval.js";
import { evaluateExecutionApprovals } from "../../domain/approvals/approval-policy.js";
import type { ApprovalInvalidReason } from "../../domain/approvals/approval-policy.js";
import type { ApprovalKind } from "../../domain/approvals/approval.js";
import { decide } from "../../domain/shared/decision.js";
import type { Decision } from "../../domain/shared/decision.js";
import type { ApprovalStore, ApprovalSubjectReader } from "../ports/approval-store.js";

/** Required approvals come from the trusted execution plan; worker results cannot remove them. */
export interface ExecutionApprovalRequirement {
  readonly approvalId: string;
  readonly subjectId: string;
  readonly kind: ApprovalKind;
}

/** Call immediately before dispatch/spend, using current baselines/estimates, not a cached flag. */
export function checkExecutionApprovals(
  deps: {
    readonly store: ApprovalStore;
    readonly subjects: ApprovalSubjectReader;
    readonly now: () => number;
  },
  requirements: readonly ExecutionApprovalRequirement[],
  allowedActors: readonly string[],
  authorActor?: string,
): Decision<ApprovalInvalidReason> {
  const now = deps.now();
  return decide(
    requirements.flatMap((requirement) => {
      const request = deps.store.get(requirement.approvalId);
      const parsed = approvalSubjectSchema.safeParse(
        deps.subjects.read(requirement.subjectId, requirement.kind),
      );
      if (
        !parsed.success ||
        parsed.data.kind !== requirement.kind ||
        (request !== undefined && request.subjectId !== requirement.subjectId)
      ) {
        return ["SUBJECT_MISMATCH" as const];
      }
      const result = evaluateExecutionApprovals([
        {
          request,
          expected: {
            subject: parsed.data,
            allowedActors,
            now,
            ...(authorActor === undefined ? {} : { authorActor }),
          },
        },
      ]);
      return result.allowed ? [] : result.reasons;
    }),
  );
}
