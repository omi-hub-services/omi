import { describeReworkCycle } from "../../../domain/runs/rework-cycle.js";
import type { StepStatus } from "../../../domain/runs/step-run.js";
import {
  buildWorkflowDiagram,
  compareLoadedSkills,
} from "../../../domain/workflows/workflow-diagram.js";
import type { QuotaVerdict } from "../../../domain/profiles/quota-policy.js";
import type { Hold } from "../../../domain/workflows/workflow-diagram.js";
import { layoutWorkflowDiagram } from "../../../domain/workflows/workflow-diagram-layout.js";
import { CONTRACT_SCHEMA_VERSION } from "../../contracts/schema-version.js";
import type { Workflow } from "../../contracts/workflow.js";
import type { BoardTask, GithubTaskList } from "../../ports/github-task-list.js";
import type { RunOverview, RunOverviewReader } from "../../ports/run-overview-reader.js";
import type { WorkflowCatalog } from "../../ports/workflow-catalog.js";

export type { TaskCard, WatchSnapshot } from "../../contracts/watch-snapshot.js";
import type {
  QuotaPanel,
  QuotaRow,
  TaskCard,
  WatchSnapshot,
} from "../../contracts/watch-snapshot.js";

export interface WatchDeps {
  readonly runs: RunOverviewReader;
  readonly workflows: Pick<WorkflowCatalog, "byHash">;
  /** Optional: failed reads keep the last good board data; runtime cards remain available. */
  readonly board?: GithubTaskList | undefined;
  /** Subscription quota per profile, without spending a call; absent when the project has none. */
  readonly quota?: (() => Promise<readonly QuotaInput[]>) | undefined;
  /** Ids of the rules every worker gets; absent when the catalog is not at hand. */
  readonly mandatoryRules?: readonly string[] | undefined;
  readonly now: () => number;
}

export interface QuotaInput {
  readonly tool: "claude" | "codex";
  readonly verdict: QuotaVerdict;
}

const ATTENTION = ["current", "failed", "blocked", "waiting-po"];

function cardOf(
  run: RunOverview,
  workflow: Workflow | undefined,
  task: BoardTask | undefined,
  now: number,
  mandatoryRules: readonly string[] | undefined,
): TaskCard {
  const cycle = { ...describeReworkCycle(run.rework), failures: run.rework.countedCycleIds.length };
  const running = run.attempts.filter((attempt) => attempt.status === "running");
  const openBlockers =
    task === undefined
      ? []
      : task.blockers.filter((blocker) => blocker.state !== "CLOSED").map((b) => b.number);
  const waitingForPo =
    run.status === "waiting_approval" ||
    run.steps.some((step) => step.status === "waiting_approval") ||
    run.rework.phase === "blocked";
  const notes: string[] = [];
  if (task?.blockersTruncated === true) notes.push("more blockers than could be read");
  // A running worker keeps the step; a held task is only drawn as held when nothing runs.
  let hold: Hold | null = null;
  if (running.length === 0) {
    if (waitingForPo) hold = { kind: "waiting-po" };
    else if (
      run.status === "blocked" ||
      openBlockers.length > 0 ||
      task?.blockersTruncated === true
    )
      hold = { kind: "blocked", by: openBlockers };
  } else if (openBlockers.length > 0) {
    notes.push(`worker runs but blocked by ${openBlockers.map((n) => `#${String(n)}`).join(", ")}`);
  }

  const statuses = new Map<string, StepStatus>(run.steps.map((s) => [s.stepId, s.status]));
  const diagram =
    workflow === undefined
      ? { nodes: [] }
      : buildWorkflowDiagram({
          workflow,
          steps: statuses,
          cycle,
          failures: cycle.failures,
          ...(hold === null ? {} : { hold }),
        });
  if (workflow === undefined) notes.push("workflow template of this run was not found");

  const stepNodes = diagram.nodes.filter((node) => node.kind === "step");
  const current =
    stepNodes.find((node) => ATTENTION.includes(node.state)) ??
    stepNodes.find((node) => node.state === "todo");
  const step =
    workflow === undefined
      ? (run.steps.find((s) => s.status !== "succeeded")?.stepId ?? null)
      : (current?.id ?? null);
  const attempt =
    run.attempts.find((a) => a.stepId === step && a.status === "running") ??
    running[0] ??
    run.attempts.find((a) => a.stepId === step);
  const loadedAttempt = run.attempts.find((a) => a.stepId === step);
  const loaded =
    loadedAttempt === undefined
      ? null
      : {
          skills: loadedAttempt.skills,
          rules: loadedAttempt.rules,
          mandatoryRules:
            mandatoryRules === undefined
              ? null
              : loadedAttempt.rules.filter((rule) => mandatoryRules.includes(rule)),
        };
  return {
    runId: run.runId,
    issueNumber: run.issueNumber,
    planKey: task?.planKey ?? null,
    title: task?.title ?? null,
    workflow: workflow?.id ?? null,
    runStatus: run.status,
    step,
    role: current?.role ?? loadedAttempt?.role ?? null,
    who:
      running.length === 0 || attempt === undefined
        ? null
        : {
            executor: attempt.executor,
            profileId: attempt.profileId,
            model: attempt.model,
            effort: attempt.effort ?? null,
            startedAt: attempt.startedAt,
            step: attempt.stepId,
            role: attempt.role ?? null,
            elapsedSeconds: elapsedSeconds(attempt.startedAt, now),
          },
    loaded,
    skillCheck:
      workflow === undefined || step === null || loaded === null
        ? null
        : (compareLoadedSkills(workflow, step, loaded.skills) ?? null),
    cycle,
    hold,
    diagram,
    layout: layoutWorkflowDiagram(diagram, workflow?.id ?? null),
    notes,
  };
}

function elapsedSeconds(startedAt: string, now: number): number | null {
  const started = Date.parse(startedAt);
  return Number.isNaN(started) ? null : Math.max(0, Math.floor((now - started) / 1000));
}

function quotaRows(inputs: readonly QuotaInput[]): QuotaRow[] {
  return inputs
    .map(({ tool, verdict }): QuotaRow => {
      const unknown = verdict.fiveHourLeft === null && verdict.sevenDayLeft === null;
      return {
        tool,
        profile: verdict.profileId,
        fiveHourLeft: verdict.fiveHourLeft,
        sevenDayLeft: verdict.sevenDayLeft,
        resetText: null,
        severity: unknown ? "unknown" : verdict.blocked.length > 0 ? "critical" : "ok",
        freshness: verdict.freshness,
        note: null,
      };
    })
    .sort(
      (a, b) =>
        Number(a.tool === "codex") - Number(b.tool === "codex") ||
        a.profile.localeCompare(b.profile),
    );
}

/**
 * The cards of every run that is not closed, from the runtime's own state: the run's pinned
 * workflow template, its step and attempt rows and the rework controller. GitHub is asked only for
 * titles and blockers at most once per minute; failed refreshes retain the last good data.
 * Each watch owns its cache. Runtime state is read on every poll; no GitHub comment is read.
 */
export function createWatchSnapshotReader(deps: WatchDeps): () => Promise<WatchSnapshot> {
  let tasks: readonly BoardTask[] = [];
  let board: WatchSnapshot["board"] = "not-configured";
  let nextBoardReadAt = -Infinity;
  let refresh: Promise<void> | undefined;
  let quota: QuotaPanel =
    deps.quota === undefined
      ? { state: "not-configured", reason: null, rows: [] }
      : { state: "loading", reason: null, rows: [] };
  let nextQuotaReadAt = -Infinity;
  let quotaRefresh: Promise<void> | undefined;
  const refreshQuota = async (read: () => Promise<readonly QuotaInput[]>) => {
    try {
      quota = { state: "ok", reason: null, rows: quotaRows(await read()) };
    } catch {
      // never the error text: it may carry a token or a response body
      quota = { state: "unavailable", reason: "QUOTA_READ_FAILED", rows: [] };
    } finally {
      nextQuotaReadAt = deps.now() + 60_000;
    }
  };
  const refreshBoard = async (reader: GithubTaskList) => {
    try {
      tasks = await reader.listTasks();
      board = "ok";
    } catch {
      board = "unavailable";
    } finally {
      nextBoardReadAt = deps.now() + 60_000;
    }
  };
  return async () => {
    if (deps.board !== undefined && deps.now() >= nextBoardReadAt) {
      refresh ??= refreshBoard(deps.board);
      await refresh;
      refresh = undefined;
    }
    if (deps.quota !== undefined && deps.now() >= nextQuotaReadAt) {
      quotaRefresh ??= refreshQuota(deps.quota);
      await quotaRefresh;
      quotaRefresh = undefined;
    }
    const cards = deps.runs
      .listActive()
      .map((run) =>
        cardOf(
          run,
          deps.workflows.byHash(run.templateHash)?.workflow,
          tasks.find((task) => task.number === run.issueNumber),
          deps.now(),
          deps.mandatoryRules,
        ),
      )
      .sort(
        (a, b) => Number(b.who !== null) - Number(a.who !== null) || a.issueNumber - b.issueNumber,
      );
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      generatedAt: new Date(deps.now()).toISOString(),
      board,
      tasks: cards,
      quota,
    };
  };
}
