import {
  requestApprovalSchema,
  recordApprovalSchema,
  type RequestApprovalInput,
  type RecordApprovalInput,
} from "../../application/contracts/approval.js";
import type { RequestApprovalResult } from "../../application/use-cases/approvals/request-approval.js";
import type { RecordApprovalResult } from "../../application/use-cases/approvals/record-approval.js";
import type { RuntimeStatus } from "../../application/contracts/runtime-status.js";
import type { CommandHandler } from "./protocol.js";

/** The use cases the dispatcher may call. Bootstrap binds them to real dependencies. */
export interface DispatchedUseCases {
  inspectRuntime(): RuntimeStatus;
  requestApproval?(input: RequestApprovalInput): RequestApprovalResult;
  recordApproval?(input: RecordApprovalInput): Promise<RecordApprovalResult>;
}

/**
 * Routes an already validated command to a use case. It holds no business rule: it only maps a
 * command name to a call. Commands whose use case does not exist yet answer NOT_IMPLEMENTED
 * (never a silent success), so the v1 command set can be added one Issue at a time.
 */
export function createCommandDispatcher(useCases: DispatchedUseCases): CommandHandler {
  return async (command) => {
    switch (command.command) {
      case "approval.request": {
        if (useCases.requestApproval === undefined) return notImplemented("approval requests");
        const input = Object.fromEntries(
          Object.entries(command).filter(([key]) => key !== "command"),
        );
        return presentApprovalResult(useCases.requestApproval(requestApprovalSchema.parse(input)));
      }
      case "approval.decide": {
        if (useCases.recordApproval === undefined) return notImplemented("approval decisions");
        const input = Object.fromEntries(
          Object.entries(command).filter(([key]) => key !== "command"),
        );
        return presentApprovalResult(
          await useCases.recordApproval(recordApprovalSchema.parse(input)),
        );
      }
      case "status":
        // Run-level status needs a state read port that no Issue has added yet.
        if (command.runId !== undefined) {
          return Promise.resolve(notImplemented("status for a single run"));
        }
        return Promise.resolve({ ok: true, result: useCases.inspectRuntime() });
      case "plan":
      case "dispatch":
      case "wait":
      case "pause":
      case "resume":
        return Promise.resolve(notImplemented(`command "${command.command}"`));
    }
  };
}

function notImplemented(what: string) {
  return {
    ok: false,
    error: { code: "NOT_IMPLEMENTED", message: `${what} is not implemented yet` },
  } as const;
}

function presentApprovalResult(result: RequestApprovalResult | RecordApprovalResult) {
  return result.ok
    ? { ok: true as const, result: result.request }
    : {
        ok: false as const,
        error: { code: "APPROVAL_REFUSED" as const, message: `Approval refused: ${result.reason}` },
      };
}
