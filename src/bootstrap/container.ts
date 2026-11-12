import { createRunMergeEvidenceReader } from "../application/services/build-run-merge-evidence.js";
import { existsSync, mkdirSync } from "node:fs";
import { createFileRuleSource } from "../infrastructure/config/load-resolution-catalog.js";
import { createFileSkillSource } from "../infrastructure/config/file-skill-source.js";
import { loadRuntimeConfig } from "../infrastructure/config/load-runtime-config.js";
import { createDispatchPlanner } from "../application/services/plan-step-dispatch.js";
import { createDispatchTaskReader } from "../application/services/resolve-dispatch-task.js";
import { snapshotRunContext } from "../application/services/snapshot-run-context.js";
import type { CompletionRouting } from "../application/services/complete-run-attempt.js";
import { writeCheckpoint } from "../application/use-cases/runs/write-checkpoint.js";
import type { FailoverStepDependencies } from "../application/use-cases/profiles/failover-step.js";
import {
  dispatchPlannedRunStep,
  type DispatchRunStepDependencies,
} from "../application/use-cases/runs/dispatch-run-step.js";
import type { AgentExecutor } from "../application/ports/agent-executor.js";
import type { ArtifactStore } from "../application/ports/artifact-store.js";
import { createSqliteAttemptStore } from "../infrastructure/persistence/sqlite/sqlite-attempt-store.js";
import { createSqliteDispatchTaskSource } from "../infrastructure/persistence/sqlite/sqlite-dispatch-task-source.js";
import { createSqliteRunDeliveryStore } from "../infrastructure/persistence/sqlite/sqlite-run-delivery-store.js";
import { createSqliteRunPlanStore } from "../infrastructure/persistence/sqlite/sqlite-run-plan-store.js";
import {
  createSqliteRecoveryRunReader,
  createSqliteStepRunReader,
} from "../infrastructure/persistence/sqlite/sqlite-recovery-run-reader.js";
import { createSqliteLeaseStore } from "../infrastructure/persistence/sqlite/sqlite-lease-store.js";
import { createSqliteOutboxStore } from "../infrastructure/persistence/sqlite/sqlite-outbox-store.js";
import { createSqlitePrMappingStore } from "../infrastructure/persistence/sqlite/sqlite-pr-mapping-store.js";
import { createLocalArtifactStore } from "../infrastructure/artifacts/local-artifact-store.js";
import { createLocalCheckpointStore } from "../infrastructure/artifacts/local-checkpoint-store.js";
import { sha256ContentHasher } from "../infrastructure/artifacts/sha256-content-hasher.js";
import { createCliGitWorkspace } from "../infrastructure/git/cli-git-workspace.js";
import { createProcessCheckRunner } from "../infrastructure/processes/process-check-runner.js";
import { createGithubRestClient } from "../infrastructure/github/github-rest-client.js";
import { createGhApiTransport } from "../infrastructure/github/gh-api-transport.js";
import type { GithubTransport } from "../infrastructure/github/github-transport.js";
import { createGithubRemote } from "../infrastructure/github/github-remote.js";
import { createGithubMergeDelivery } from "../infrastructure/github/github-merge-delivery.js";
import { ClaudeCodeExecutor } from "../infrastructure/executors/claude-code/claude-code-executor.js";
import { CodexExecutor } from "../infrastructure/executors/codex/codex-executor.js";
import type { startSupervisedProcess } from "../infrastructure/processes/supervised-process.js";
import { installProjectTool } from "../application/use-cases/project/install-project-tool.js";
import { initializeProject } from "../application/use-cases/project/initialize-project.js";
import { createOnboardingProjectConfigStore } from "../infrastructure/config/project-config-store.js";
import { createCodebaseReader } from "../infrastructure/config/codebase-reader.js";
import { createOnboardingFileStore } from "../infrastructure/config/onboarding-file-store.js";
import { createOnboardingTemplateSource } from "../infrastructure/config/onboarding-template-source.js";
import { readOptional } from "../infrastructure/config/package-content.js";
import { createGithubProjectReader } from "../infrastructure/github/github-project-reader.js";
import { inspectInstallation } from "../application/use-cases/project/inspect-installation.js";
import { createProjectInstallation } from "../infrastructure/config/install-project-package.js";
import { createInstallationDoctor } from "../infrastructure/processes/installation-doctor.js";
import { fileURLToPath } from "node:url";
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
import { wakeWaitingRunSteps } from "../application/use-cases/runs/wake-waiting-run-steps.js";
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
import {
  createSqliteApprovalStore,
  createSqliteTaskApprovalSubjects,
} from "../infrastructure/persistence/sqlite/sqlite-approval-store.js";
import { createSqliteProfileRegistry } from "../infrastructure/profiles/sqlite-profile-registry.js";
import { createProfileQuotaReader } from "../infrastructure/profiles/profile-quota-reader.js";
import { createClaudeQuotaReader } from "../infrastructure/executors/claude-code/claude-code-quota.js";
import { createCodexQuotaReader } from "../infrastructure/executors/codex/codex-quota.js";
import type { QuotaReader } from "../application/ports/quota-reader.js";
import { registerProfile } from "../application/use-cases/profiles/register-profile.js";
import { probeRegisteredProfile } from "../application/use-cases/profiles/probe-profile.js";
import { createSqliteExecutorSelectionStore } from "../infrastructure/profiles/sqlite-executor-selection-store.js";
import { createSqliteStateUnitOfWork } from "../infrastructure/persistence/sqlite/sqlite-state-unit-of-work.js";
import type { StateDatabase } from "../infrastructure/persistence/sqlite/sqlite-connection.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectRuntime } from "../application/use-cases/project/inspect-runtime.js";
import type { RuntimeIdentity } from "../application/use-cases/project/inspect-runtime.js";
import type { CliEnvironment } from "../interfaces/cli/commands/create-program.js";
import type { TaskCommands } from "../interfaces/cli/commands/task-commands.js";
import { createIssueFromSpec } from "../application/use-cases/tasks/create-issue-from-spec.js";
import { promoteTask } from "../application/use-cases/tasks/promote-task.js";
import { setTaskStatus } from "../application/use-cases/tasks/set-task-status.js";
import { createIssueSpecFile } from "../infrastructure/config/issue-spec-file.js";
import { createGithubIntake } from "../infrastructure/github/github-intake.js";
import { createGithubTaskBoard } from "../infrastructure/github/github-task-board.js";
import type { DispatchedUseCases } from "../interfaces/ipc/command-dispatcher.js";
import { createCommandDispatcher } from "../interfaces/ipc/command-dispatcher.js";
import { sendCommand } from "../interfaces/ipc/ipc-client.js";
import { createIpcServer } from "../interfaces/ipc/ipc-server.js";
import type { IpcServer } from "../interfaces/ipc/ipc-server.js";

/** Both stores share one migrated connection for atomic profile/account capacity reservations. */
export function createProfileStores(
  database: StateDatabase,
  options?: {
    readonly fence: import("../application/ports/state-unit-of-work.js").LeaseFence;
    readonly now: () => number;
  },
) {
  const registry = createSqliteProfileRegistry(database);
  return { registry, selections: createSqliteExecutorSelectionStore(database, registry, options) };
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

/** Intake and promote commands: GitHub is the project's own repository and Project (project.yaml). */
export function createTaskCommands(
  transport: GithubTransport = createGhApiTransport(),
): TaskCommands {
  async function github(projectDir: string) {
    const config = await createOnboardingProjectConfigStore(projectDir).read();
    if (config === undefined) throw new Error("PROJECT_NOT_CONFIGURED");
    const client = createGithubRestClient({
      transport,
      now: Date.now,
      random: Math.random,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    });
    const deps = {
      client,
      projects: createGithubProjectReader(client),
      repository: config.repository,
      project: { owner: config.project.owner, number: config.project.number },
    };
    return { intake: createGithubIntake(deps), board: createGithubTaskBoard(deps) };
  }
  return {
    newIssue: async (input) =>
      createIssueFromSpec(
        { spec: createIssueSpecFile(input.file), intake: (await github(input.projectDir)).intake },
        { prefix: input.prefix, apply: input.apply },
      ),
    promote: async (input) => promoteTask({ board: (await github(input.projectDir)).board }, input),
    setStatus: async (input) =>
      setTaskStatus({ board: (await github(input.projectDir)).board }, input),
  };
}

/** Wires the CLI to the real IPC client. Used by `cli.ts`; tests may pass their own environment. */
export function createCliEnvironment(options: CliWiringOptions): CliEnvironment {
  return {
    sendCommand,
    tasks: createTaskCommands(),
    installation: {
      initialize: async (input) =>
        initializeProject(
          {
            github: createGithubProjectReader(
              createGithubRestClient({
                transport: createGhApiTransport(),
                now: Date.now,
                random: Math.random,
                sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
              }),
            ),
            config: createOnboardingProjectConfigStore(input.projectDir),
            onboarding: {
              codebase: await createCodebaseReader(
                input.projectDir,
                fileURLToPath(new URL("../..", import.meta.url)),
              ),
              files: await createOnboardingFileStore(input.projectDir),
              templates: createOnboardingTemplateSource(
                fileURLToPath(new URL("../../templates/project/workflows", import.meta.url)),
              ),
            },
          },
          {
            config: JSON.parse((await readOptional(input.configFile)) ?? "null") as unknown,
            source: { kind: "codebase", variant: input.variant },
            apply: input.apply,
          },
        ),
      install: (input) =>
        installProjectTool(
          createProjectInstallation({
            sourceRoot: fileURLToPath(new URL("../..", import.meta.url)),
          }),
          input,
        ),
      doctor: (input) => inspectInstallation(createInstallationDoctor(), input),
    },
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
  readonly profiles?: Pick<DispatchedUseCases, "registerProfile" | "listProfiles" | "probeProfile">;
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
      ...options.profiles,
      ...options.runs,
    }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
}

export function createProfileUseCases(database: StateDatabase, canSave: () => boolean) {
  const registry = createSqliteProfileRegistry(database);
  const executors = { "claude-code": new ClaudeCodeExecutor(), codex: new CodexExecutor() };
  return {
    registerProfile: (input: unknown) =>
      canSave()
        ? registerProfile(registry, input, Date.now)
        : { ok: false as const, reason: "SESSION_STOPPING" },
    listProfiles: () => ({ ok: true as const, profiles: registry.list() }),
    probeProfile: (input: unknown) =>
      probeRegisteredProfile(
        registry,
        executors,
        typeof input === "object" && input !== null && "profileId" in input
          ? input.profileId
          : undefined,
        Date.now,
        canSave,
      ),
  };
}

/** Wire only inside the runtime, using its already migrated database and authoritative subjects. */
export function createApprovalUseCases(options: {
  readonly database: StateDatabase;
  readonly subjects: ApprovalSubjectReader;
  readonly repository: string;
  readonly allowedGitHubActors: readonly string[];
  readonly fence?: import("../application/ports/state-unit-of-work.js").LeaseFence;
}): Pick<DispatchedUseCases, "requestApproval" | "recordApproval"> {
  const unitOfWork = createSqliteStateUnitOfWork(options.database, options.fence);
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
  readonly completion?: CompletionRouting;
  readonly executors?: Readonly<Record<"claude-code" | "codex", AgentExecutor>>;
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
  const dispatchDeps = {
    ...dispatch,
    ...wiring.completion,
    ...(wiring.executors === undefined ? {} : { executors: wiring.executors }),
    runs,
    plans,
    workflows,
    session,
    planner: wiring.planner,
  };
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
    readonly prepareSnapshot?: NonNullable<PauseRunDependencies["prepareSnapshot"]>;
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

export interface RuntimeCompositionOptions {
  readonly transport?: GithubTransport;
  readonly now?: () => number;
  /** Test boundary for quota readings; production reads the profiles' own usage (ADR-0033). */
  readonly quotaReader?: QuotaReader;
  /** Reversible test boundary: no fake mode or executable override is read from Issue text. */
  readonly executors?: (ports: {
    readonly attempts: AttemptStore;
    readonly artifacts: ArtifactStore;
    readonly onWorkerStarted: (attemptId: string, worker: SupervisedProcess) => void;
    readonly startProcess: typeof startSupervisedProcess;
  }) => Readonly<Record<"claude-code" | "codex", AgentExecutor>>;
}

/** Production composition, called after migration under the runtime's project-owner lease. */
export async function createProjectRunCommandUseCases(
  options: RuntimeCompositionOptions & {
    readonly projectDir: string;
    readonly database: StateDatabase;
    readonly session: ProjectSession;
    readonly startProcess: typeof startSupervisedProcess;
  },
) {
  const { database, session, projectDir } = options;
  const runs = createSqliteRecoveryRunReader(database);
  // An uninitialised project can still expose status and typed refusals for every run command.
  if (!existsSync(join(projectDir, ".omi-squad", "config", "project.yaml"))) {
    const refuse = () => ({ ok: false as const, reason: "PROJECT_NOT_CONFIGURED" });
    return {
      runs,
      commands: {
        planRun: refuse,
        dispatchRunStep: refuse,
        waitForRun: refuse,
        inspectRun: refuse,
        pauseRun: refuse,
        resumeRun: refuse,
        deliverRun: refuse,
        handoffCoordinator: refuse,
      },
      drain: () => Promise.resolve(),
      resourceWakeup: undefined,
      approvals: {
        requestApproval: () => ({ ok: false as const, reason: "SUBJECT_NOT_FOUND" as const }),
        recordApproval: () => Promise.resolve({ ok: false as const, reason: "NOT_FOUND" as const }),
      },
    };
  }
  const config = await loadRuntimeConfig(join(projectDir, ".omi-squad"));
  const now = options.now ?? Date.now;
  const nextId = randomUUID;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const state = createSqliteStateUnitOfWork(database, session.lease);
  const plans = createSqliteRunPlanStore(database, { fence: session.lease, now });
  const attempts = createSqliteAttemptStore(database, { fence: session.lease, now });
  const profiles = createProfileStores(database, { fence: session.lease, now });
  const root = join(projectDir, ".omi-squad", "local", "runs");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const artifacts = createLocalArtifactStore(root, database);
  const checkpoints = createLocalCheckpointStore(root, database);
  const workspaces = createCliGitWorkspace(
    {
      mainWorktreePath: projectDir,
      directoryNaming: "plan-key",
      ...(config.project.workspace === undefined
        ? {}
        : { worktreesRoot: config.project.workspace.worktree_root }),
    },
    createSqliteLeaseStore(database),
  );
  const processRecovery = createRunProcessRecovery({ database, session, attempts, now });
  const executorPorts = {
    attempts,
    artifacts,
    onWorkerStarted: processRecovery.onWorkerStarted,
    startProcess: options.startProcess,
  };
  const executors = options.executors?.(executorPorts) ?? {
    "claude-code": new ClaudeCodeExecutor(executorPorts),
    codex: new CodexExecutor(executorPorts),
  };
  const client = createGithubRestClient({
    transport: options.transport ?? createGhApiTransport(),
    now,
    random: Math.random,
    sleep,
  });
  const taskReader = createDispatchTaskReader(
    createSqliteDispatchTaskSource(database, client),
    now,
  );
  const planner = createDispatchPlanner({
    // Real readers exist only when the project opted in with a `quota` block (ADR-0033); without
    // it nothing here can reach the usage endpoint, `codex app-server` or a probe.
    ...(config.project.quota === undefined
      ? {}
      : {
          quota:
            options.quotaReader ??
            createProfileQuotaReader({
              "claude-code": createClaudeQuotaReader({
                probe: { executable: "claude", parentEnv: process.env },
              }),
              codex: createCodexQuotaReader({ executable: "codex", parentEnv: process.env }),
            }),
        }),
    config: config.project,
    models: config.models,
    plans,
    workflows: config.workflows,
    profiles: profiles.registry,
    selections: profiles.selections,
    task: (taskId) => taskReader.read(taskId),
    nextAttemptNumber: (stepRunId) => attempts.nextNumberForStep(stepRunId),
    cancelReservation: (attemptId) => {
      attempts.setStatus(attemptId, "cancelled");
    },
    now,
    nextId,
  });
  const rework = createSqliteReworkRunReader(database);
  const configHash = sha256ContentHasher.sha256(
    JSON.stringify({ project: config.project, models: config.models, catalog: config.catalog }),
  );
  const snapshotDeps = {
    runs,
    rework,
    plans,
    attempts,
    artifacts,
    task: taskReader.current,
    configHash,
    workspaces,
    now,
    nextId,
  };
  const snapshot = (runId: string) => snapshotRunContext(snapshotDeps, runId);
  const checkpointDeps = {
    checkpoints,
    attempts,
    artifacts,
    workspaces,
    hasher: sha256ContentHasher,
    now,
    nextId,
  };
  const dispatch: DispatchStepDependencies = {
    catalog: config.catalog,
    skills: createFileSkillSource(join(projectDir, ".omi-squad")),
    rules: createFileRuleSource(join(projectDir, ".omi-squad")),
    steps: createSqliteStepRunReader(database),
    attempts,
    artifacts,
    workspaces,
    executor: executors["claude-code"],
    unitOfWork: state,
    leaseTtlMs: config.project.limits.step_timeout_seconds * 1000 + 60_000,
    now,
    nextId,
    // The readiness gate reads the live Project before a task branch is created (OMI-079).
    board: createGithubTaskBoard({
      client,
      projects: createGithubProjectReader(client),
      repository: config.project.repository,
      project: { owner: config.project.project.owner, number: config.project.project.number },
    }),
    checkpoint: (event) => {
      const saved = writeCheckpoint(checkpointDeps, {
        ...snapshotRunContext(snapshotDeps, event.runId, event),
        runId: event.runId,
        kind: event.kind,
        outputs: event.outputs,
        ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      });
      return saved.ok ? { ok: true } : { ok: false, reason: saved.reason };
    },
  };
  const github = {
    outbox: createSqliteOutboxStore(database),
    artifacts,
    github: createGithubRemote(client),
    now,
    newEventId: nextId,
    reconcileGraceMs: 120_000,
  };
  const completions = new Set<Promise<void>>();
  const track = (completion: Promise<void>) => {
    completions.add(completion);
    void completion.finally(() => completions.delete(completion));
  };
  const dependencies = (): DispatchRunStepDependencies => bound;
  const recoveryDeps: ResumeRunDependencies = {
    session,
    runs,
    attempts,
    processes: processRecovery.processes,
    checkpoints,
    artifacts,
    workspaces,
    github,
    now,
    nextId,
    validateGates: async (checkpoint) => {
      const plan = plans.forRun(checkpoint.runId);
      if (
        plan === undefined ||
        plan.templateHash !== checkpoint.hashes.template ||
        checkpoint.hashes.config !== configHash
      )
        return { ok: false, reason: "CONFIG_OR_TEMPLATE_CHANGED" };
      const current = await taskReader.read(plan.taskId);
      return current.context.businessBaselineHash === checkpoint.businessBaselineHash
        ? { ok: true }
        : { ok: false, reason: "BUSINESS_BASELINE_CHANGED" };
    },
    dispatch: async (_checkpoint, step) =>
      dispatchRunStep(dependencies(), { runId: step.runId, stepId: step.stepId }),
  };
  const failover: FailoverStepDependencies = {
    ...recoveryDeps,
    profiles: profiles.registry,
    selections: profiles.selections,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
    jitter: Math.random,
    dispatch: async ({ step, selection }) => {
      const plan = plans.forRun(step.runId);
      if (plan === undefined) return { ok: false, reason: "TASK_NOT_FOUND" };
      const request = await planner.planReserved(
        { runId: step.runId, stepRunId: step.id, stepId: step.stepId, taskId: plan.taskId },
        selection,
      );
      return dispatchPlannedRunStep(dependencies(), request, step.id, step.runId);
    },
  };
  const completion: CompletionRouting = {
    // Only configured checks exist; with none, no id is runtime-owned and nothing is run.
    ...(config.project.checks === undefined
      ? {}
      : {
          checks: createProcessCheckRunner({
            checks: Object.fromEntries(
              Object.entries(config.project.checks).map(([id, check]) => [
                id,
                { command: check.command, timeoutMs: check.timeout_seconds * 1000 },
              ]),
            ),
            artifacts,
            now,
            nextId,
          }),
        }),
    failoversMade: (stepRunId) => attempts.failoversForStep(stepRunId),
    failover,
    selections: profiles.selections,
    rework: {
      runs: rework,
      session,
      nextId,
      checkpoint: (runId, quality) => {
        const saved = writeCheckpoint(checkpointDeps, {
          ...snapshot(runId),
          runId,
          kind: "before-side-effect",
          counters: { failedCycles: quality.failedCycles },
        });
        return saved.ok ? { ok: true, checkpointId: saved.checkpoint.id } : { ok: false };
      },
    },
  };
  const bound: DispatchRunStepDependencies = {
    ...dispatch,
    ...completion,
    executors,
    runs,
    plans,
    workflows: config.workflows,
    session,
    planner,
    track,
  };
  const recovery = createRunRecoveryUseCases({
    ...recoveryDeps,
    hasher: sha256ContentHasher,
    snapshot,
    prepareSnapshot: async (runId) => {
      const plan = plans.forRun(runId);
      if (plan === undefined) throw new Error("TASK_NOT_FOUND");
      await taskReader.read(plan.taskId);
    },
  });
  const delivery = createSqliteRunDeliveryStore(database, attempts, session);
  const merge: MergeTaskPrDeps = {
    ...github,
    tasks: delivery.tasks,
    evidence: createRunMergeEvidenceReader(delivery.source, artifacts),
    unitOfWork: state,
    newId: nextId,
    batchSize: 10,
    jitter: Math.random,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
    mappings: createSqlitePrMappingStore(database),
    leases: createSqliteLeaseStore(database),
    reader: createGithubMergeDelivery(client),
    mergeLockOwner: session.lease.owner,
    mergeLockTtlMs: 60_000,
  };
  const commands = createRunCommandUseCases({
    session,
    runs,
    plans,
    workflows: config.workflows,
    dispatch,
    planner,
    executors,
    completion,
    track,
    recovery,
    merge,
    sleep,
    pollMs: 100,
  });
  return {
    runs,
    commands,
    approvals: createApprovalUseCases({
      database,
      subjects: createSqliteTaskApprovalSubjects(database),
      repository: `${config.project.repository.owner}/${config.project.repository.name}`,
      allowedGitHubActors: config.project.policies.github_approval_actors ?? [],
      fence: session.lease,
    }),
    resourceWakeup: (canDispatch: () => boolean) => ({
      timing: config.project.resource_wait,
      tick: () =>
        wakeWaitingRunSteps({ ...bound, runs, session, profiles: profiles.registry, canDispatch }),
    }),
    drain: async () => {
      while (completions.size > 0) await Promise.allSettled([...completions]);
    },
  };
}
