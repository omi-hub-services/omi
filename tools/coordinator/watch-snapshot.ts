// Pure mapping of the repo's reads (GitHub board, WSL workers and worker prompts, quota) into the
// framework's WatchSnapshot contract (OMI-092, ADR-0014), so /omi-watch serves the one framework
// page. The diagram decisions and geometry are the framework's (src/domain/workflows); this file
// only says where each task stands. Strings from outside are stripped of control characters here
// and rendered only through `textContent` by the page.
import type {
  QuotaPanel,
  QuotaRow,
  TaskCard,
  WatchSnapshot,
} from "../../src/application/contracts/watch-snapshot.ts";
import type { ReworkCycle } from "../../src/domain/runs/rework-cycle.ts";
import type { RunStatus } from "../../src/domain/runs/workflow-run.ts";
import "../register-ts-imports.ts";
import type { QuotaSettings, WorkerProfile } from "./coordinator-settings.ts";
import { tokenExpiredText, windowLeft, type QuotaReport, type QuotaWindow } from "./quota.ts";
import { clean, resetText, STALE_AFTER_SECONDS } from "./watch-core.ts";
import { buildTasks, type CyclePhase, type TasksRead, type TaskView } from "./watch-tasks.ts";
import { standingOf } from "./watch-workflow.ts";
import type { Workers } from "./wsl-workers.ts";

// dynamic: the register hook above must run before src/ (`.js` specifiers) is resolved
const { buildWorkflowDiagram, compareLoadedSkills } =
  await import("../../src/domain/workflows/workflow-diagram.ts");
const { layoutWorkflowDiagram } =
  await import("../../src/domain/workflows/workflow-diagram-layout.ts");
const { quotaSeverity } = await import("../../src/domain/profiles/quota-policy.ts");
const { CONTRACT_SCHEMA_VERSION } =
  await import("../../src/application/contracts/schema-version.ts");

export interface SnapshotInput {
  readonly workers: Workers | null;
  readonly tasks: TasksRead | null;
  readonly quota: QuotaReport | null;
  /** Unix seconds. */
  readonly now: number;
  readonly settings: QuotaSettings;
  readonly profiles: readonly WorkerProfile[];
}

const MAX_FAILURES_PER_SEGMENT = 2;
const unknownIfDash = (value: string) => (value === "-" ? "unknown" : value);

function reworkCycle(c: CyclePhase): ReworkCycle & { readonly failures: number } {
  const of = MAX_FAILURES_PER_SEGMENT;
  switch (c.phase) {
    case "before-architect":
      return { phase: c.phase, rework: c.k, of, architect: "none", failures: c.fails };
    case "architect":
      return {
        phase: c.phase,
        rework: c.k,
        of,
        architect: c.architectCalled ? "called" : "needed",
        failures: c.fails,
      };
    case "after-architect":
      return { phase: c.phase, rework: c.k, of, architect: "called", failures: c.fails };
    case "escalate-po":
      return { phase: c.phase, rework: of, of, architect: "called", failures: c.fails };
  }
}

function runStatusOf(view: TaskView): RunStatus {
  if (view.worker !== null) return "running";
  if (view.hold?.kind === "waiting-po") return "waiting_approval";
  if (view.hold?.kind === "blocked") return "blocked";
  return view.step === "Done" ? "succeeded" : "pending";
}

function cardOf(view: TaskView): TaskCard {
  const cycle = reworkCycle(view.cycle);
  const template = view.template;
  const standing =
    template === null
      ? undefined
      : standingOf({
          workflow: template,
          pos: view.pos,
          running: view.worker !== null,
          fails: view.cycle.fails,
          architect: view.step === "Architect",
        });
  const diagram =
    template === null || standing === undefined
      ? { nodes: [] }
      : buildWorkflowDiagram({
          workflow: template,
          steps: standing.steps,
          cycle,
          failures: cycle.failures,
          ...(view.hold === null ? {} : { hold: view.hold }),
          ...(standing.atGate === undefined ? {} : { atGate: standing.atGate }),
        });
  const prompt = view.prompt;
  const notes = [view.stepReason, template === null ? view.templateReason : null].flatMap((note) =>
    note === null ? [] : [note],
  );
  const worker = view.worker;
  return {
    runId: view.planKey === "-" ? `issue-${String(view.issue ?? 0)}` : view.rowId,
    issueNumber: view.issue ?? 0,
    planKey: view.planKey === "-" ? null : view.planKey,
    title: view.title === "-" ? null : view.title,
    workflow: template?.id ?? null,
    runStatus: runStatusOf(view),
    step: view.pos.kind === "node" ? view.pos.id : null,
    role: view.role === "-" ? null : view.role,
    who:
      worker === null
        ? null
        : {
            executor: worker.tool,
            profileId: unknownIfDash(worker.profile),
            model: unknownIfDash(worker.model),
            effort: worker.effort === "-" ? null : worker.effort,
            startedAt: null,
            step: view.workerStep?.step ?? null,
            role: view.workerStep?.role ?? null,
            elapsedSeconds: worker.elapsedSeconds,
          },
    loaded:
      prompt === null
        ? null
        : { skills: prompt.skills, rules: prompt.rules, mandatoryRules: prompt.mandatoryRules },
    skillCheck:
      template === null || view.workerStep === null || prompt === null
        ? null
        : (compareLoadedSkills(template, view.workerStep.step, prompt.skills) ?? null),
    cycle,
    hold: view.hold,
    diagram,
    layout: layoutWorkflowDiagram(diagram, template?.id ?? null),
    notes,
  };
}

function windowView(w: QuotaWindow | null, now: number, clockOnly: boolean) {
  if (w === null) return null;
  return { left: windowLeft(w, now), resetText: resetText(w.resetsAt, now, clockOnly) };
}

function quotaPanel(input: SnapshotInput): QuotaPanel {
  const { quota, now, settings } = input;
  const rows = input.profiles.map((profile): QuotaRow => {
    const base = { tool: profile.tool, profile: clean(profile.profile) };
    const entry = quota?.available
      ? quota.profiles.find((p) => p.tool === profile.tool && p.profile === profile.profile)
      : undefined;
    const r = entry?.reading;
    if (!r) {
      return {
        ...base,
        fiveHourLeft: null,
        sevenDayLeft: null,
        resetText: null,
        severity: "unknown",
        freshness: "unknown",
        note: clean(
          (entry && tokenExpiredText(entry, now)) ??
            entry?.note ??
            (quota ? "unavailable" : "loading"),
        ),
      };
    }
    const five = windowView(r.fiveHour, now, true);
    const seven = windowView(r.sevenDay, now, false);
    return {
      ...base,
      fiveHourLeft: five?.left ?? null,
      sevenDayLeft: seven?.left ?? null,
      resetText: five?.resetText ?? null,
      severity: quotaSeverity(
        { fiveHourLeft: five?.left ?? null, sevenDayLeft: seven?.left ?? null, limited: r.limited },
        settings,
      ),
      freshness: Math.max(0, now - r.observedAt) > STALE_AFTER_SECONDS ? "stale" : "fresh",
      note: clean(tokenExpiredText(entry, now) ?? entry.note ?? "") || null,
    };
  });
  rows.sort(
    (a, b) =>
      Number(a.tool === "codex") - Number(b.tool === "codex") || a.profile.localeCompare(b.profile),
  );
  if (!quota) return { state: "loading", reason: null, rows };
  if (!quota.available) return { state: "unavailable", reason: clean(quota.reason) || "-", rows };
  return { state: "ok", reason: null, rows };
}

export function buildSnapshot(input: SnapshotInput): WatchSnapshot {
  const tasks = buildTasks({ tasks: input.tasks, workers: input.workers });
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    generatedAt: new Date(input.now * 1000).toISOString(),
    board: tasks.state === "loading" ? "loading" : tasks.state === "ok" ? "ok" : "unavailable",
    tasks: tasks.state === "ok" ? tasks.items.map(cardOf) : [],
    quota: quotaPanel(input),
  };
}
