import {
  requestApprovalSchema,
  recordApprovalSchema,
  type RequestApprovalInput,
  type RecordApprovalInput,
} from "../../application/contracts/approval.js";
import type { RequestApprovalResult } from "../../application/use-cases/approvals/request-approval.js";
import type { RecordApprovalResult } from "../../application/use-cases/approvals/record-approval.js";
import type { RuntimeStatus } from "../../application/contracts/runtime-status.js";
import type { CommandHandler, HandlerOutcome } from "./protocol.js";

/** What a run use case answers: a value, or a refusal with a stable reason. */
type UseCaseOutcome =
  | ({ readonly ok: true } & Readonly<Record<string, unknown>>)
  | { readonly ok: false; readonly reason: string; readonly detail?: string };
type RunUseCase = (input: unknown) => UseCaseOutcome | Promise<UseCaseOutcome>;

/** The use cases the dispatcher may call. Bootstrap binds them to real dependencies. */
export interface DispatchedUseCases {
  importTasks?: RunUseCase;
  inspectRuntime(): RuntimeStatus;
  requestApproval?(input: RequestApprovalInput): RequestApprovalResult;
  recordApproval?(input: RecordApprovalInput): Promise<RecordApprovalResult>;
  planRun?: RunUseCase;
  dispatchRunStep?: RunUseCase;
  readWorkerReport?: RunUseCase;
  commitWorker?: RunUseCase;
  postReviewComment?: RunUseCase;
  waitForRun?: RunUseCase;
  inspectRun?: RunUseCase;
  pauseRun?: RunUseCase;
  resumeRun?: RunUseCase;
  deliverRun?: RunUseCase;
  mergeRelease?: RunUseCase;
  handoffCoordinator?: RunUseCase;
  registerProfile?: RunUseCase;
  listProfiles?: RunUseCase;
  probeProfile?: RunUseCase;
}

/** The command minus the routing fields; each use case validates the rest itself. */
function payloadOf(command: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(command).filter(([key]) => key !== "command" && key !== "schemaVersion"),
  );
}

/**
 * Routes an already validated command to a use case. It holds no business rule: it only maps a
 * command name to a call. Commands whose use case does not exist yet answer NOT_IMPLEMENTED
 * (never a silent success), so the v1 command set can be added one Issue at a time.
 */
export function createCommandDispatcher(useCases: DispatchedUseCases): CommandHandler {
  const run = async (
    useCase: RunUseCase | undefined,
    what: string,
    command: Readonly<Record<string, unknown>>,
  ): Promise<HandlerOutcome> =>
    useCase === undefined
      ? notImplemented(what)
      : presentRunResult(await useCase(payloadOf(command)));

  return async (command) => {
    switch (command.command) {
      case "task.import":
        return run(useCases.importTasks, "task import", command);
      case "profile.register":
        return run(useCases.registerProfile, "profile registration", command);
      case "profile.list":
        return run(useCases.listProfiles, "profile listing", command);
      case "profile.probe":
        return run(useCases.probeProfile, "profile probe", command);
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
        if (command.runId !== undefined) {
          return run(useCases.inspectRun, "status for a single run", command);
        }
        return Promise.resolve({ ok: true, result: useCases.inspectRuntime() });
      case "plan":
        return run(useCases.planRun, 'command "plan"', command);
      case "dispatch":
        return run(useCases.dispatchRunStep, 'command "dispatch"', command);
      case "worker-report":
        return run(useCases.readWorkerReport, 'command "worker-report"', command);
      case "commit-worker":
        return run(useCases.commitWorker, 'command "commit-worker"', command);
      case "review-comment":
        return run(useCases.postReviewComment, 'command "review-comment"', command);
      case "wait":
        return run(useCases.waitForRun, 'command "wait"', command);
      case "pause":
        return run(useCases.pauseRun, 'command "pause"', command);
      case "resume":
        return run(useCases.resumeRun, 'command "resume"', command);
      case "deliver":
        return run(useCases.deliverRun, 'command "deliver"', command);
      case "release.merge":
        return run(useCases.mergeRelease, 'command "merge-release"', command);
      case "handoff":
        return run(useCases.handoffCoordinator, 'command "handoff"', command);
    }
  };
}

function notImplemented(what: string) {
  return {
    ok: false,
    error: { code: "NOT_IMPLEMENTED", message: `${what} is not implemented yet` },
  } as const;
}

function presentRunResult(outcome: UseCaseOutcome): HandlerOutcome {
  if (outcome.ok) {
    return {
      ok: true,
      result: Object.fromEntries(Object.entries(outcome).filter(([key]) => key !== "ok")),
    };
  }
  const detail = outcome.detail === undefined ? "" : `: ${outcome.detail}`;
  return {
    ok: false,
    error: { code: "COMMAND_REFUSED", message: `${outcome.reason}${detail}`.slice(0, 1000) },
  };
}

function presentApprovalResult(result: RequestApprovalResult | RecordApprovalResult) {
  return result.ok
    ? { ok: true as const, result: result.request }
    : {
        ok: false as const,
        error: { code: "APPROVAL_REFUSED" as const, message: `Approval refused: ${result.reason}` },
      };
}
