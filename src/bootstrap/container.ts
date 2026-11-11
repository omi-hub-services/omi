import type { AttemptStore } from "../application/ports/attempt-store.js";
import type { ActiveRunReader } from "../application/ports/active-run-reader.js";
import type { DispatchPlanner } from "../application/ports/dispatch-planner.js";
import type { RecoveryRunReader } from "../application/ports/run-recovery.js";
import type { RunPlanStore } from "../application/ports/run-plan-store.js";
import type { WorkflowCatalog } from "../application/ports/workflow-catalog.js";
import { deliverRun } from "../application/use-cases/delivery/deliver-run.js";
import type { MergeTaskPrDeps } from "../application/use-cases/delivery/merge-task-pr.js";
import { dispatchRunStep } from "../application/use-cases/runs/dispatch-run-step.js";
import type { DispatchStepDependencies } from "../application/use-cases/runs/dispatch-step.js";
import { handoffCoordinator } from "../application/use-cases/runs/handoff-coordinator.js";
import { inspectRun } from "../application/use-cases/runs/inspect-run.js";
import { requestRunPause } from "../application/use-cases/runs/request-run-pause.js";
import { planRun } from "../application/use-cases/runs/plan-run.js";
import { waitForRun } from "../application/use-cases/runs/wait-for-run.js";
import type { ProjectSession } from "../application/ports/lease-store.js";
import {
  recordReworkEvent,
  type RecordReworkEventDependencies,
} from "../application/use-cases/runs/record-rework-event.js";
import { createSqliteReworkRunReader } from "../infrastructure/persistence/sqlite/sqlite-rework-run-reader.js";
import type { SupervisedProcess } from "../infrastructure/processes/supervised-process.js";
import { createWorkerRecovery } from "../infrastructure/processes/worker-recovery.js";
import { createSqliteWorkerProcessStore } from "../infrastructure/persistence/sqlite/sqlite-worker-process-store.js";
import { pauseRun, type PauseRunDependencies } from "../application/use-cases/runs/pause-run.js";
import { resumeRun, type ResumeRunDependencies } from "../application/use-cases/runs/resume-run.js";
import type { WriteCheckpointDependencies } from "../application/use-cases/runs/write-checkpoint.js";
import type { ExecutorSelectionStore } from "../application/ports/executor-selection-store.js";
import { launchWindowsSession } from "../infrastructure/processes/windows-session-launcher.js";
import { readStandardInput } from "../infrastructure/processes/read-standard-input.js";
import { randomUUID } from "node:crypto";
import { requestApproval } from "../application/use-cases/approvals/request-approval.js";
import { recordApproval } from "../application/use-cases/approvals/record-approval.js";
import type { ApprovalSubjectReader } from "../application/ports/approval-store.js";
import { createGitHubApprovalDecisionSource } from "../infrastructure/github/github-approval-decision-source.js";
import { createInteractiveApprovalConfirmation } from "../infrastructure/processes/interactive-approval-decision.js";
import { createSqliteApprovalStore } from "../infrastructure/persistence/sqlite/sqlite-approval-store.js";
import { createSqliteProfileRegistry } from "../infrastructure/profiles/sqlite-profile-registry.js";
import { createSqliteExecutorSelectionStore } from "../infrastructure/profiles/sqlite-executor-selection-store.js";
import { createSqliteStateUnitOfWork } from "../infrastructure/persistence/sqlite/sqlite-state-unit-of-work.js";
import type { StateDatabase } from "../infrastructure/persistence/sqlite/sqlite-connection.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectRuntime } from "../application/use-cases/project/inspect-runtime.js";
import type { RuntimeIdentity } from "../application/use-cases/project/inspect-runtime.js";
import type { CliEnvironment } from "../interfaces/cli/commands/create-program.js";
import type { DispatchedUseCases } from "../interfaces/ipc/command-dispatcher.js";
import { createCommandDispatcher } from "../interfaces/ipc/command-dispatcher.js";
import { sendCommand } from "../interfaces/ipc/ipc-client.js";
import { createIpcServer } from "../interfaces/ipc/ipc-server.js";
import type { IpcServer } from "../interfaces/ipc/ipc-server.js";

/** Both stores share one migrated connection for atomic profile/account capacity reservations. */
export function createProfileStores(database: StateDatabase) {
  const registry = createSqliteProfileRegistry(database);
  return { registry, selections: createSqliteExecutorSelectionStore(database, registry) };
}

/** Bind the quality controller to the current runtime owner and checkpoint boundary.
 * The workflow consumes architect_required by dispatching its Architect role through dispatchStep.
 */
export function createReworkUseCase(
  options: Omit<RecordReworkEventDependencies, "runs"> & { readonly database: StateDatabase },
) {
  const dependencies = { ...options, runs: createSqliteReworkRunReader(options.database) };
  return (input: unknown) => recordReworkEvent(dependencies, input);
}

/** Where the runtime listens for a project (architecture.md §4: `.omi-squad/local/ipc/`). */
export function defaultSocketPath(projectDir: string): string {
  return join(projectDir, ".omi-squad", "local", "ipc", "runtime.sock");
}

/** The package version, read once at start-up (the same file for `src/` and for `dist/`). */
export function readPackageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  throw new Error("package.json has no string version");
}

export interface CliWiringOptions {
  readonly socketPath: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly timeoutMs?: number;
}

/** Wires the CLI to the real IPC client. Used by `cli.ts`; tests may pass their own environment. */
export function createCliEnvironment(options: CliWiringOptions): CliEnvironment {
  return {
    sendCommand,
    launchSession: launchWindowsSession,
    readStdin: () => readStandardInput(process.stdin),
    defaultSocketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? 5_000,
    version: readPackageVersion(),
    stdout: options.stdout,
    stderr: options.stderr,
  };
}

/**
 * Wires the runtime side: IPC server → dispatcher → use cases. It does not start a process or
 * decide when to stop; the runtime lifecycle belongs to OMI-016.
 */
export function createRuntimeIpcServer(options: {
  readonly socketPath: string;
  readonly identity: RuntimeIdentity;
  readonly selections?: Pick<ExecutorSelectionStore, "listSettings">;
  readonly approvals?: Pick<DispatchedUseCases, "requestApproval" | "recordApproval">;
  readonly runs?: RunCommandUseCases;
  /** Lets `status` list the unfinished runs. */
  readonly activeRuns?: ActiveRunReader;
  readonly idleTimeoutMs?: number;
}): IpcServer {
  return createIpcServer({
    socketPath: options.socketPath,
    handler: createCommandDispatcher({
      inspectRuntime: () =>
        inspectRuntime(options.identity, options.selections, options.activeRuns),
      ...options.approvals,
      ...options.runs,
    }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
}

/** Wire only inside the runtime, using its already migrated database and authoritative subjects. */
export function createApprovalUseCases(options: {
  readonly database: StateDatabase;
  readonly subjects: ApprovalSubjectReader;
  readonly repository: string;
  readonly allowedGitHubActors: readonly string[];
}): Pick<DispatchedUseCases, "requestApproval" | "recordApproval"> {
  const unitOfWork = createSqliteStateUnitOfWork(options.database);
  const source = createGitHubApprovalDecisionSource({
    repository: options.repository,
    confirmCli: createInteractiveApprovalConfirmation(),
  });
  const shared = { subjects: options.subjects, unitOfWork, now: Date.now, nextId: randomUUID };
  return {
    requestApproval: (input) => requestApproval(shared, input),
    recordApproval: (input) =>
      recordApproval(
        {
          ...shared,
          source,
          store: createSqliteApprovalStore(options.database),
          allowedGitHubActors: options.allowedGitHubActors,
        },
        input,
      ),
  };
}

export type RunCommandUseCases = Pick<
  DispatchedUseCases,
  | "planRun"
  | "dispatchRunStep"
  | "waitForRun"
  | "inspectRun"
  | "pauseRun"
  | "resumeRun"
  | "deliverRun"
  | "handoffCoordinator"
>;

export interface RunCommandWiring {
  /** The runtime's claimed project-owner session; every run state change goes through it. */
  readonly session: ProjectSession;
  readonly runs: RecoveryRunReader & ActiveRunReader;
  readonly plans: RunPlanStore;
  readonly workflows: WorkflowCatalog;
  /** Workflow used when `plan` names none. */
  readonly defaultWorkflowId?: string;
  /** Ports of the worker that runs steps: executor, workspaces, attempts, artifacts, state. */
  readonly dispatch: DispatchStepDependencies;
  readonly planner: DispatchPlanner;
  /** Receives each attempt's completion promise so the runtime can drain it on shutdown. */
  readonly track: (completion: Promise<void>) => void;
  readonly recovery: ReturnType<typeof createRunRecoveryUseCases>;
  readonly merge: MergeTaskPrDeps;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
}

/**
 * Binds the Coordinator's run commands (plan, dispatch, wait, status, pause, resume, deliver,
 * handoff) to their use cases. Wire only inside the runtime that holds the project-owner session.
 * The use cases hold the rules; this function only supplies their dependencies.
 */
export function createRunCommandUseCases(wiring: RunCommandWiring): RunCommandUseCases {
  const { session, runs, plans, workflows, dispatch } = wiring;
  const dispatchDeps = { ...dispatch, runs, plans, workflows, session, planner: wiring.planner };
  return {
    planRun: (input) =>
      planRun(
        {
          tasks: plans,
          workflows,
          ...(wiring.defaultWorkflowId === undefined
            ? {}
            : { defaultWorkflowId: wiring.defaultWorkflowId }),
          now: dispatch.now,
          nextId: dispatch.nextId,
        },
        input,
      ),
    dispatchRunStep: (input) => dispatchRunStep({ ...dispatchDeps, track: wiring.track }, input),
    waitForRun: (input) =>
      waitForRun({ runs, now: dispatch.now, sleep: wiring.sleep, pollMs: wiring.pollMs }, input),
    inspectRun: (input) => inspectRun({ runs }, input),
    pauseRun: (input) => requestRunPause({ session, pause: wiring.recovery.pauseRun }, input),
    resumeRun: async (input) => {
      const resumed = await wiring.recovery.resumeRun(input);
      // The checkpoint manifest is large and is not the Coordinator's to act on; report the
      // attempt that was started.
      return resumed.ok
        ? {
            ok: true,
            ...(resumed.attemptId === undefined ? {} : { attemptId: resumed.attemptId }),
            ...(resumed.stepRunId === undefined ? {} : { stepRunId: resumed.stepRunId }),
          }
        : resumed;
    },
    deliverRun: (input) =>
      deliverRun({ runs, plans, merge: wiring.merge, session, nextId: dispatch.nextId }, input),
    handoffCoordinator: (input) =>
      handoffCoordinator(
        {
          runs,
          session,
          pause: (runId) => wiring.recovery.pauseRun({ runId }),
        },
        input,
      ),
  };
}

/** Bind recovery to the existing session owner. The workflow supplies its pinned execution plan,
 * current approval/check validator and dispatchStep binding; this factory introduces no daemon.
 */
export function createRunRecoveryUseCases(
  options: ResumeRunDependencies & {
    readonly hasher: WriteCheckpointDependencies["hasher"];
    readonly snapshot: PauseRunDependencies["snapshot"];
    readonly credentialPolicy?: NonNullable<WriteCheckpointDependencies["credentialPolicy"]>;
  },
) {
  return {
    pauseRun: (input: unknown) => pauseRun(options, input),
    resumeRun: (input: unknown) => resumeRun(options, input),
  };
}

/** Pass onWorkerStarted to either CLI executor and processes to the recovery use cases. */
export function createRunProcessRecovery(options: {
  readonly database: StateDatabase;
  readonly session: ProjectSession;
  readonly attempts: AttemptStore;
  readonly now: () => number;
}) {
  const processes = createWorkerRecovery(
    createSqliteWorkerProcessStore(options.database, {
      fence: options.session.lease,
      now: options.now,
    }),
  );
  return {
    processes,
    onWorkerStarted: (attemptId: string, worker: SupervisedProcess): void => {
      const attempt = options.attempts.get(attemptId);
      if (attempt === undefined) throw new Error("ATTEMPT_NOT_FOUND");
      processes.track(attempt, worker);
    },
  };
}
